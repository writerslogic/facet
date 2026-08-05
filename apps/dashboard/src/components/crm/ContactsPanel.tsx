// The contacts roster: search, status filter, paging, create, and a detail pane for the selected
// person. Master/detail rather than a modal, matching how the rest of the app puts a selection and
// its context on screen at once.

import { Plus } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { CRM_PAGE_SIZE, useContact, useContacts, useCreateContact } from '../../hooks/crm.js';
import { cn } from '../../lib/cn.js';
import { CONTACT_STATUSES, canAdministerCrm } from '../../lib/crm.js';
import { CardSkeletons, EmptyState } from '../StatusStates.js';
import { ContactDetail } from './ContactDetail.js';
import { ContactForm } from './ContactForm.js';
import { CrmAccessNotice, Pager, StatusChip } from './shared.js';

/** How long a keystroke waits before it becomes a request. Long enough that typing a name is one
 * query rather than eight, short enough that the list still feels live. */
const SEARCH_DEBOUNCE_MS = 300;

export function ContactsPanel({
	siteId,
	selectedId,
	onSelect,
	onOpenCompany,
}: {
	siteId: string;
	/** Owned by the tab shell so a company's roster can select a contact from the other panel. */
	selectedId: string;
	onSelect: (contactId: string) => void;
	onOpenCompany: (companyId: string) => void;
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

	const list = useContacts(siteId, { status, q: query, offset });
	const canAdminister = canAdministerCrm(list.data?.role);
	// The selected contact is read on its own rather than plucked from the page, so it survives
	// paging, a search that no longer matches it, and an edit that changed the row.
	const selected = useContact(siteId, selectedId);
	const create = useCreateContact(siteId);

	if (list.error) {
		return (
			<CrmAccessNotice
				error={list.error}
				subject="contacts"
				onRetry={() => void list.refetch()}
				retrying={list.isFetching}
			/>
		);
	}

	const contacts = list.data?.contacts ?? [];
	const total = list.data?.total ?? 0;
	const filtering = Boolean(query.trim() || status);

	return (
		<div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
			<div className="min-w-0 space-y-3">
				<div className="flex flex-wrap items-end gap-2">
					<div className="min-w-0 flex-1">
						<label
							htmlFor="crm-contact-search"
							className="block font-medium text-[color:var(--muted)] text-xs"
						>
							Search
						</label>
						<input
							id="crm-contact-search"
							type="search"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Name, email or company"
							className="input mt-1 block w-full rounded-lg px-3 py-1.5 text-sm"
						/>
					</div>
					<div className="min-w-0">
						<label
							htmlFor="crm-contact-status"
							className="block font-medium text-[color:var(--muted)] text-xs"
						>
							Status
						</label>
						<select
							id="crm-contact-status"
							value={status}
							onChange={(e) => {
								setStatus(e.target.value);
								setOffset(0);
							}}
							className="input mt-1 block rounded-lg px-3 py-1.5 text-sm"
						>
							<option value="">All</option>
							{CONTACT_STATUSES.map((value) => (
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
						New contact
					</button>
				</div>

				{creating ? (
					<ContactForm
						siteId={siteId}
						contact={null}
						submitLabel="Create contact"
						pendingLabel="Creating…"
						isPending={create.isPending}
						error={create.error}
						onCancel={() => setCreating(false)}
						onSubmit={(fields) =>
							create.mutate(fields, {
								onSuccess: (result) => {
									setCreating(false);
									onSelect(result.contact.id);
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
				) : contacts.length === 0 ? (
					<EmptyState title={filtering ? 'No contacts match' : 'No contacts yet'}>
						{filtering ? (
							<>Clear the search or the status filter to see the whole roster.</>
						) : (
							<>
								A contact is a person your site already knows by name. Add one
								above, and give them the same external user id your site sends to
								Facet if you want their analytics to link.
							</>
						)}
					</EmptyState>
				) : (
					<>
						<div className="surface overflow-x-auto rounded-2xl">
							<table className="w-full min-w-[28rem] border-collapse text-sm">
								<caption className="sr-only">
									Contacts on this site, newest first.
								</caption>
								<thead>
									<tr>
										{['Contact', 'Company', 'Status'].map((label) => (
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
									{contacts.map((contact) => (
										<tr
											key={contact.id}
											className="border-[color:rgb(var(--border))] border-t align-middle"
										>
											<th
												scope="row"
												className="max-w-[16rem] px-3 py-2 text-left align-middle font-normal"
											>
												<button
													type="button"
													data-selectable
													onClick={() => onSelect(contact.id)}
													aria-current={
														contact.id === selectedId
															? 'true'
															: undefined
													}
													className={cn(
														'flex w-full min-w-0 flex-col rounded-lg px-1.5 py-1 text-left transition hover:bg-[color:rgb(var(--hover))]',
														contact.id === selectedId &&
															'bg-[color:rgb(var(--hover))]',
													)}
												>
													<span className="truncate font-medium text-[color:var(--ink)]">
														{contact.name ||
															contact.email ||
															contact.external_user_id ||
															'Unnamed contact'}
													</span>
													{contact.email && contact.name ? (
														<span className="truncate text-[color:var(--faint)] text-xs">
															{contact.email}
														</span>
													) : null}
												</button>
											</th>
											<td
												data-selectable
												className="max-w-[12rem] truncate px-3 py-2 text-[color:var(--muted)]"
											>
												{contact.company ?? '—'}
											</td>
											<td className="px-3 py-2 text-right">
												<StatusChip status={contact.status} />
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
							noun="contacts"
						/>
					</>
				)}
			</div>

			<div className="min-w-0">
				{!selectedId ? (
					<p className="surface rounded-xl p-5 text-center text-[color:var(--muted)] text-sm">
						Pick a contact to see their record, whether their analytics are linked, and
						the erasure and export controls.
					</p>
				) : selected.error ? (
					<CrmAccessNotice
						error={selected.error}
						subject="this contact"
						onRetry={() => void selected.refetch()}
						retrying={selected.isFetching}
					/>
				) : selected.data ? (
					<ContactDetail
						siteId={siteId}
						contact={selected.data.contact}
						canAdminister={canAdminister}
						onOpenCompany={onOpenCompany}
						onDeleted={(erased) => {
							setDeleted(
								erased === 1
									? 'Contact erased, along with 1 consent record.'
									: `Contact erased, along with ${erased} consent records.`,
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
