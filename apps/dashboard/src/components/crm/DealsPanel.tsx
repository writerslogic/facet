// The deals roster: pipeline summary, stage filter, search, paging, create, and a detail pane for the
// selected deal. Master/detail, matching ContactsPanel/CompaniesPanel.

import { ArrowLeft, Plus } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import {
	CRM_PAGE_SIZE,
	useCompany,
	useContact,
	useCreateDeal,
	useDeal,
	useDealPipeline,
	useDeals,
} from '../../hooks/crm.js';
import { useDebouncedValue } from '../../hooks/debounce.js';
import { cn } from '../../lib/cn.js';
import { DEAL_STAGES, canAdministerCrm, formatMoney } from '../../lib/crm.js';
import { formatNumber } from '../../lib/format.js';
import { CardSkeletons, EmptyState, Skeleton } from '../StatusStates.js';
import { DealDetail } from './DealDetail.js';
import { DealForm } from './DealForm.js';
import { CrmAccessNotice, Pager, StatusChip } from './shared.js';

const SEARCH_DEBOUNCE_MS = 300;

/** One currency's row: open value and count beside won value and count. Deliberately not summed
 * across the two, since "open plus won" is not a quantity anyone asked for. */
function PipelineRow({
	summary,
}: {
	summary: {
		currency: string;
		open_value: number;
		open_count: number;
		won_value: number;
		won_count: number;
	};
}): ReactElement {
	return (
		<div className="surface-2 min-w-0 rounded-lg px-3 py-2">
			<p data-chrome className="text-[color:var(--faint)] text-[11px]">
				{summary.currency}
			</p>
			<div className="mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
				<p data-selectable className="text-[color:var(--ink)] text-sm">
					<span className="font-semibold tabular-nums">
						{formatMoney(summary.open_value, summary.currency)}
					</span>{' '}
					<span className="text-[color:var(--faint)] text-xs">
						open · {formatNumber(summary.open_count)}
					</span>
				</p>
				<p data-selectable className="text-[color:var(--ink)] text-sm">
					<span className="font-semibold tabular-nums">
						{formatMoney(summary.won_value, summary.currency)}
					</span>{' '}
					<span className="text-[color:var(--faint)] text-xs">
						won · {formatNumber(summary.won_count)}
					</span>
				</p>
			</div>
		</div>
	);
}

function PipelineSummary({ siteId }: { siteId: string }): ReactElement | null {
	const pipeline = useDealPipeline(siteId);
	// Silent on failure — the roster below reports the same access error, and repeating it here would
	// just be a second copy of the same explanation stacked above the one that already has a retry.
	if (pipeline.error) return null;
	if (!pipeline.data) return <Skeleton className="h-14 w-full" />;
	if (pipeline.data.pipeline.length === 0) return null;
	return (
		<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
			{pipeline.data.pipeline.map((row) => (
				<PipelineRow key={row.currency} summary={row} />
			))}
		</div>
	);
}

/** Named when the reader arrived from a company's or contact's detail view, asking about its deals
 * specifically — mirrors AuditPanel's targetId banner. */
function FilterBanner({
	siteId,
	companyFilter,
	contactFilter,
	onClear,
}: {
	siteId: string;
	companyFilter: string;
	contactFilter: string;
	onClear: () => void;
}): ReactElement | null {
	const company = useCompany(siteId, companyFilter);
	const contact = useContact(siteId, contactFilter);
	if (!companyFilter && !contactFilter) return null;
	const label = companyFilter
		? (company.data?.company.name ?? companyFilter)
		: contact.data?.contact.name ||
			contact.data?.contact.email ||
			contact.data?.contact.external_user_id ||
			contactFilter;
	return (
		<div className="surface-2 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs">
			<p data-chrome className="text-[color:var(--muted)]">
				Showing deals for{' '}
				<span data-selectable className="font-medium text-[color:var(--ink)]">
					{label}
				</span>
				.
			</p>
			<button
				type="button"
				onClick={onClear}
				className="btn-ghost inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition"
			>
				<ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
				Clear filter
			</button>
		</div>
	);
}

export function DealsPanel({
	siteId,
	selectedId,
	onSelect,
	onOpenCompany,
	onOpenContact,
	onOpenAudit,
	companyFilter = '',
	contactFilter = '',
	onClearFilter,
}: {
	siteId: string;
	selectedId: string;
	onSelect: (dealId: string) => void;
	onOpenCompany: (companyId: string) => void;
	onOpenContact: (contactId: string) => void;
	/** Open the access log filtered to this deal. */
	onOpenAudit?: (targetId: string) => void;
	/** Pre-set when the reader arrived from a company's or contact's detail view — mutually
	 * exclusive, since a deal names at most one of each. */
	companyFilter?: string;
	contactFilter?: string;
	onClearFilter?: () => void;
}): ReactElement {
	const [search, setSearch] = useState('');
	const [stage, setStage] = useState('');
	const [offset, setOffset] = useState(0);
	const [creating, setCreating] = useState(false);
	const [deleted, setDeleted] = useState<string | null>(null);
	// Settling and resetting the offset in the same tick, not a separate effect watching `query` —
	// see useDebouncedValue's doc comment for why that gap matters here.
	const query = useDebouncedValue(search, SEARCH_DEBOUNCE_MS, () => setOffset(0));

	// A filter arriving from a different company/contact (or being cleared) also starts the roster
	// over. Adjusted during render rather than a `useEffect` watching the props, for the same reason
	// as above: an effect fires one render after `companyFilter`/`contactFilter` change, so the
	// `useDeals` call just below would go out once with the new filter and the stale offset first.
	const [prevFilters, setPrevFilters] = useState({ companyFilter, contactFilter });
	if (
		prevFilters.companyFilter !== companyFilter ||
		prevFilters.contactFilter !== contactFilter
	) {
		setPrevFilters({ companyFilter, contactFilter });
		setOffset(0);
	}

	const list = useDeals(siteId, {
		stage,
		companyId: companyFilter,
		contactId: contactFilter,
		q: query,
		offset,
	});
	const canAdminister = canAdministerCrm(list.data?.role);
	// Read on its own, same reasoning as ContactsPanel: it survives paging, a search that no longer
	// matches it, and an edit that changed the row.
	const selected = useDeal(siteId, selectedId);
	const create = useCreateDeal(siteId);

	if (list.error) {
		return (
			<CrmAccessNotice
				error={list.error}
				subject="deals"
				onRetry={() => void list.refetch()}
				retrying={list.isFetching}
			/>
		);
	}

	const deals = list.data?.deals ?? [];
	const total = list.data?.total ?? 0;
	const filtering = Boolean(query.trim() || stage || companyFilter || contactFilter);

	return (
		<div className="space-y-3">
			<PipelineSummary siteId={siteId} />
			{onClearFilter ? (
				<FilterBanner
					siteId={siteId}
					companyFilter={companyFilter}
					contactFilter={contactFilter}
					onClear={onClearFilter}
				/>
			) : null}
			<div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
				<div className="min-w-0 space-y-3">
					<div className="flex flex-wrap items-end gap-2">
						<div className="min-w-0 flex-1">
							<label
								htmlFor="crm-deal-search"
								className="block font-medium text-[color:var(--muted)] text-xs"
							>
								Search
							</label>
							<input
								id="crm-deal-search"
								type="search"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Deal name"
								className="input mt-1 block w-full rounded-lg px-3 py-1.5 text-sm"
							/>
						</div>
						<div className="min-w-0">
							<label
								htmlFor="crm-deal-stage"
								className="block font-medium text-[color:var(--muted)] text-xs"
							>
								Stage
							</label>
							<select
								id="crm-deal-stage"
								value={stage}
								onChange={(e) => {
									setStage(e.target.value);
									setOffset(0);
								}}
								className="input mt-1 block rounded-lg px-3 py-1.5 text-sm"
							>
								<option value="">All</option>
								{DEAL_STAGES.map((value) => (
									<option key={value} value={value}>
										{value}
									</option>
								))}
							</select>
						</div>
						<button
							type="button"
							onClick={() => setCreating((open) => !open)}
							className="btn-accent inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-sm transition"
						>
							<Plus className="h-3.5 w-3.5" aria-hidden="true" />
							New deal
						</button>
					</div>

					{creating ? (
						<DealForm
							siteId={siteId}
							deal={null}
							submitLabel="Create deal"
							pendingLabel="Creating…"
							isPending={create.isPending}
							error={create.error}
							onCancel={() => setCreating(false)}
							onSubmit={(fields) =>
								create.mutate(fields, {
									onSuccess: (result) => {
										setCreating(false);
										onSelect(result.deal.id);
									},
								})
							}
						/>
					) : null}

					{deleted ? (
						<p
							aria-live="polite"
							className="alert-ok rounded-lg px-3 py-2 font-medium text-xs"
						>
							{deleted}
						</p>
					) : null}

					{list.isLoading ? (
						<CardSkeletons count={3} />
					) : deals.length === 0 ? (
						<EmptyState title={filtering ? 'No deals match' : 'No deals yet'}>
							{filtering ? (
								<>Clear the search or the stage filter to see the whole pipeline.</>
							) : (
								<>Add the first opportunity above to start tracking the pipeline.</>
							)}
						</EmptyState>
					) : (
						<>
							<div className="surface overflow-x-auto rounded-2xl">
								<table className="w-full min-w-[28rem] border-collapse text-sm">
									<caption className="sr-only">
										Deals on this site, newest first.
									</caption>
									<thead>
										<tr>
											{['Deal', 'Value', 'Stage'].map((label) => (
												<th
													key={label}
													scope="col"
													data-chrome
													className={cn(
														'px-3 py-2 font-semibold text-[11px] text-[color:var(--faint)] uppercase tracking-[0.06em]',
														label === 'Stage'
															? 'text-right'
															: 'text-left',
													)}
												>
													{label}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{deals.map((deal) => (
											<tr
												key={deal.id}
												className="border-[color:rgb(var(--border))] border-t align-middle"
											>
												<th
													scope="row"
													className="max-w-[16rem] px-3 py-2 text-left align-middle font-normal"
												>
													<button
														type="button"
														data-selectable
														onClick={() => onSelect(deal.id)}
														aria-current={
															deal.id === selectedId
																? 'true'
																: undefined
														}
														className={cn(
															'flex w-full min-w-0 flex-col rounded-lg px-1.5 py-1 text-left transition hover:bg-[color:rgb(var(--hover))]',
															deal.id === selectedId &&
																'bg-[color:rgb(var(--hover))]',
														)}
													>
														<span className="truncate font-medium text-[color:var(--ink)]">
															{deal.name}
														</span>
													</button>
												</th>
												<td
													data-selectable
													className="max-w-[10rem] truncate px-3 py-2 text-[color:var(--muted)]"
												>
													{deal.value != null
														? formatMoney(deal.value, deal.currency)
														: '—'}
												</td>
												<td className="px-3 py-2 text-right">
													<StatusChip status={deal.stage} />
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<Pager
								offset={offset}
								pageSize={CRM_PAGE_SIZE}
								total={total}
								onOffset={setOffset}
								noun="deals"
							/>
						</>
					)}
				</div>

				<div className="min-w-0">
					{!selectedId ? (
						<p className="surface rounded-xl p-5 text-center text-[color:var(--muted)] text-sm">
							Pick a deal to see its record, its value, and the edit and delete
							controls.
						</p>
					) : selected.error ? (
						<CrmAccessNotice
							error={selected.error}
							subject="this deal"
							onRetry={() => void selected.refetch()}
							retrying={selected.isFetching}
						/>
					) : selected.data ? (
						<DealDetail
							// Remounts on selection change so local state (the edit form, the save
							// confirmation) never survives from the previously selected deal.
							key={selected.data.deal.id}
							siteId={siteId}
							deal={selected.data.deal}
							canAdminister={canAdminister}
							onOpenCompany={onOpenCompany}
							onOpenContact={onOpenContact}
							onOpenAudit={onOpenAudit}
							onDeleted={() => {
								setDeleted('Deal deleted.');
								onSelect('');
							}}
						/>
					) : (
						<CardSkeletons count={1} />
					)}
				</div>
			</div>
		</div>
	);
}
