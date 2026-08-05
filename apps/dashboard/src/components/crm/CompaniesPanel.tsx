// The companies roster: search, status filter, paging, create, and a detail pane carrying the
// consent-gated rollup for the selected company.

import { Plus } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { CRM_PAGE_SIZE, useCompanies, useCompany, useCreateCompany } from '../../hooks/crm.js';
import { cn } from '../../lib/cn.js';
import { COMPANY_STATUSES, canAdministerCrm } from '../../lib/crm.js';
import { CardSkeletons, EmptyState } from '../StatusStates.js';
import { CompanyDetail } from './CompanyDetail.js';
import { CompanyForm } from './CompanyForm.js';
import { CrmAccessNotice, Pager, StatusChip } from './shared.js';

const SEARCH_DEBOUNCE_MS = 300;

export function CompaniesPanel({
	siteId,
	selectedId,
	onSelect,
	onOpenContact,
	onOpenAudit,
}: {
	siteId: string;
	/** Owned by the tab shell so a contact's company link can select one from the other panel. */
	selectedId: string;
	onSelect: (companyId: string) => void;
	onOpenContact: (contactId: string) => void;
	/** Open the access log filtered to one company. */
	onOpenAudit: (targetId: string) => void;
}): ReactElement {
	// The role the server served this list under — the only authoritative answer available to
	// the browser. See `canAdministerCrm`.
	const [search, setSearch] = useState('');
	const [query, setQuery] = useState('');
	const [status, setStatus] = useState('');
	const [offset, setOffset] = useState(0);
	const [creating, setCreating] = useState(false);
	const [deleted, setDeleted] = useState<string | null>(null);

	useEffect(() => {
		const timer = setTimeout(() => {
			setQuery(search);
			setOffset(0);
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [search]);

	const list = useCompanies(siteId, { status, q: query, offset });
	const canAdminister = canAdministerCrm(list.data?.role);
	const selected = useCompany(siteId, selectedId);
	const create = useCreateCompany(siteId);

	if (list.error) {
		return (
			<CrmAccessNotice
				error={list.error}
				subject="companies"
				onRetry={() => void list.refetch()}
				retrying={list.isFetching}
			/>
		);
	}

	const companies = list.data?.companies ?? [];
	const total = list.data?.total ?? 0;
	const filtering = Boolean(query.trim() || status);

	return (
		<div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
			<div className="min-w-0 space-y-3">
				<div className="flex flex-wrap items-end gap-2">
					<div className="min-w-0 flex-1">
						<label
							htmlFor="crm-company-search"
							className="block font-medium text-[color:var(--muted)] text-xs"
						>
							Search
						</label>
						<input
							id="crm-company-search"
							type="search"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Name or domain"
							className="input mt-1 block w-full rounded-lg px-3 py-1.5 text-sm"
						/>
					</div>
					<div className="min-w-0">
						<label
							htmlFor="crm-company-status"
							className="block font-medium text-[color:var(--muted)] text-xs"
						>
							Status
						</label>
						<select
							id="crm-company-status"
							value={status}
							onChange={(e) => {
								setStatus(e.target.value);
								setOffset(0);
							}}
							className="input mt-1 block rounded-lg px-3 py-1.5 text-sm"
						>
							<option value="">All</option>
							{COMPANY_STATUSES.map((value) => (
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
						New company
					</button>
				</div>

				{creating ? (
					<CompanyForm
						company={null}
						submitLabel="Create company"
						pendingLabel="Creating…"
						isPending={create.isPending}
						error={create.error}
						onCancel={() => setCreating(false)}
						onSubmit={(fields) =>
							create.mutate(fields, {
								onSuccess: (result) => {
									setCreating(false);
									onSelect(result.company.id);
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
				) : companies.length === 0 ? (
					<EmptyState title={filtering ? 'No companies match' : 'No companies yet'}>
						{filtering ? (
							<>Clear the search or the status filter to see every company.</>
						) : (
							<>
								A company turns a contact&rsquo;s employer into a structured link
								instead of typed text, and gives you one rollup across everyone who
								works there.
							</>
						)}
					</EmptyState>
				) : (
					<>
						<div className="surface overflow-x-auto rounded-2xl">
							<table className="w-full min-w-[24rem] border-collapse text-sm">
								<caption className="sr-only">Companies on this site.</caption>
								<thead>
									<tr>
										{['Company', 'Domain', 'Status'].map((label) => (
											<th
												key={label}
												scope="col"
												data-chrome
												className={cn(
													'px-3 py-2 font-semibold text-[11px] text-[color:var(--faint)] uppercase tracking-[0.06em]',
													label === 'Status' ? 'text-right' : 'text-left',
												)}
											>
												{label}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{companies.map((company) => (
										<tr
											key={company.id}
											className="border-[color:rgb(var(--border))] border-t align-middle"
										>
											<th
												scope="row"
												className="max-w-[14rem] px-3 py-2 text-left align-middle font-normal"
											>
												<button
													type="button"
													data-selectable
													onClick={() => onSelect(company.id)}
													aria-current={
														company.id === selectedId
															? 'true'
															: undefined
													}
													className={cn(
														'w-full truncate rounded-lg px-1.5 py-1 text-left font-medium text-[color:var(--ink)] transition hover:bg-[color:rgb(var(--hover))]',
														company.id === selectedId &&
															'bg-[color:rgb(var(--hover))]',
													)}
												>
													{company.name}
												</button>
											</th>
											<td
												data-selectable
												className="max-w-[12rem] truncate px-3 py-2 font-mono text-[color:var(--muted)] text-xs"
											>
												{company.domain ?? '—'}
											</td>
											<td className="px-3 py-2 text-right">
												<StatusChip status={company.status} />
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
							noun="companies"
						/>
					</>
				)}
			</div>

			<div className="min-w-0">
				{!selectedId ? (
					<p className="surface rounded-xl p-5 text-center text-[color:var(--muted)] text-sm">
						Pick a company to see who works there and how much of its traffic Facet is
						actually allowed to attribute to it.
					</p>
				) : selected.error ? (
					<CrmAccessNotice
						error={selected.error}
						subject="this company"
						onRetry={() => void selected.refetch()}
						retrying={selected.isFetching}
					/>
				) : selected.data ? (
					<CompanyDetail
						siteId={siteId}
						company={selected.data.company}
						canAdminister={canAdminister}
						onOpenContact={onOpenContact}
						onOpenAudit={onOpenAudit}
						onDeleted={(unlinked) => {
							setDeleted(
								unlinked === 1
									? 'Company deleted. 1 contact was unlinked and kept.'
									: `Company deleted. ${unlinked} contacts were unlinked and kept.`,
							);
							onSelect('');
						}}
					/>
				) : (
					<CardSkeletons count={1} />
				)}
			</div>
		</div>
	);
}
