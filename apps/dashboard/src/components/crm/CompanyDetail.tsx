// One company: its record, its roster, and the consent-gated rollup of its contacts' analytics.
//
// THE DENOMINATOR IS NOT DECORATION. A rollup covering one of twelve people reads as the account's
// traffic unless the coverage is stated next to the numbers, and an operator who mistakes it for the
// whole will start reasoning about the eleven who never consented. So `contacts_linked of
// contacts_total` is rendered above the figures on every response — linked or not — and a truncated
// rollup says it is a lower bound rather than presenting a capped sum as a total.

import { Link2Off, Users } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import {
	CRM_PAGE_SIZE,
	useCompanyAnalytics,
	useCompanyContacts,
	useDeleteCompany,
	useUpdateCompany,
} from '../../hooks/crm.js';
import { type CompanyRollupCounts, type CrmCompany, linkReasonText } from '../../lib/crm.js';
import { formatDateTime } from '../../lib/datetime.js';
import { formatNumber } from '../../lib/format.js';
import { Skeleton } from '../StatusStates.js';
import { ConfirmDelete, MutationStatus } from '../settings/kit.js';
import { CompanyForm } from './CompanyForm.js';
import { ActivityFigures, CrmAccessNotice, DetailRow, Pager, StatusChip } from './shared.js';

/** The coverage statement. Always rendered, because "how much of this company is in these numbers"
 * is part of the answer and not a caveat on it. */
function Coverage({ counts }: { counts: CompanyRollupCounts }): ReactElement {
	const { contacts_linked, contacts_total, contacts_considered, contacts_truncated } = counts;
	return (
		<div className="space-y-2">
			<div className="surface-2 rounded-lg px-3 py-2">
				<p data-chrome className="text-[color:var(--faint)] text-[11px]">
					Coverage
				</p>
				<p
					data-selectable
					className="font-semibold text-[color:var(--ink)] text-sm tabular-nums"
				>
					{formatNumber(contacts_linked)} of {formatNumber(contacts_total)}{' '}
					{contacts_total === 1 ? 'contact' : 'contacts'} linked
				</p>
				<p className="mt-0.5 max-w-prose text-[color:var(--muted)] text-xs">
					Only a contact with an active signed consent record contributes. These figures
					are not this company&rsquo;s whole traffic — they are the part {contacts_linked}{' '}
					of its {contacts_total} people authorized.
				</p>
			</div>
			{contacts_truncated ? (
				<p role="alert" className="alert-warn rounded-lg px-3 py-2 text-xs">
					<strong>Lower bound, not a total.</strong> Consent was resolved for the first{' '}
					{formatNumber(contacts_considered)} contacts only (the per-rollup limit is{' '}
					{formatNumber(counts.contacts_limit)}), so contacts beyond that are missing from
					these numbers.
				</p>
			) : null}
		</div>
	);
}

function CompanyAnalyticsPanel({
	siteId,
	companyId,
}: {
	siteId: string;
	companyId: string;
}): ReactElement {
	const analytics = useCompanyAnalytics(siteId, companyId);

	if (analytics.error) {
		return (
			<CrmAccessNotice
				error={analytics.error}
				subject="this company's rollup"
				onRetry={() => void analytics.refetch()}
				retrying={analytics.isFetching}
			/>
		);
	}
	if (!analytics.data) return <Skeleton className="h-24 w-full" />;

	const data = analytics.data;
	return (
		<div className="space-y-3">
			<Coverage counts={data} />
			{data.linked ? (
				<>
					<ActivityFigures activity={data.activity} />
					<p data-chrome className="text-[color:var(--faint)] text-xs">
						Summed over {formatNumber(data.visitor_hashes)} visitor{' '}
						{data.visitor_hashes === 1 ? 'hash' : 'hashes'} — a linkage-breadth number,
						not a headcount. The headcount is the coverage above.
					</p>
				</>
			) : (
				<div className="alert-info flex items-start gap-2.5 rounded-lg p-3 text-sm">
					<Link2Off className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
					<div className="min-w-0">
						<p className="font-semibold">Nothing here is linked to analytics</p>
						<p className="mt-0.5 max-w-prose opacity-90">
							{linkReasonText(data.reason)}
						</p>
						<p className="mt-1 max-w-prose opacity-90">
							This is <strong>not</strong> a report of zero traffic for this account.
						</p>
					</div>
				</div>
			)}
		</div>
	);
}

/** The roster query is owned by the detail, not by this list: the delete confirmation needs its
 * `total` to say how many people survive the deletion, and a child cannot hand a parent state
 * during render. */
type RosterQuery = ReturnType<typeof useCompanyContacts>;

function Roster({
	roster,
	offset,
	onOffset,
	onOpenContact,
}: {
	roster: RosterQuery;
	offset: number;
	onOffset: (next: number) => void;
	onOpenContact: (contactId: string) => void;
}): ReactElement {
	if (roster.error) {
		return (
			<CrmAccessNotice
				error={roster.error}
				subject="this company's contacts"
				onRetry={() => void roster.refetch()}
				retrying={roster.isFetching}
			/>
		);
	}
	if (!roster.data) return <Skeleton className="h-16 w-full" />;
	if (roster.data.contacts.length === 0) {
		return (
			<p className="text-[color:var(--muted)] text-sm">
				No contact is linked to this company yet. Link one from their record, under{' '}
				<strong>Linked company</strong>.
			</p>
		);
	}

	return (
		<div className="space-y-2">
			<ul className="divide-y divide-[color:rgb(var(--border))]">
				{roster.data.contacts.map((contact) => (
					<li key={contact.id}>
						<button
							type="button"
							data-selectable
							onClick={() => onOpenContact(contact.id)}
							className="flex w-full items-center justify-between gap-3 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-[color:rgb(var(--hover))]"
						>
							<span className="min-w-0">
								<span className="block truncate text-[color:var(--ink)] text-sm">
									{contact.name || contact.email || 'Unnamed contact'}
								</span>
								{contact.title ? (
									<span className="block truncate text-[color:var(--faint)] text-xs">
										{contact.title}
									</span>
								) : null}
							</span>
							<StatusChip status={contact.status} />
						</button>
					</li>
				))}
			</ul>
			<Pager
				offset={offset}
				pageSize={CRM_PAGE_SIZE}
				total={roster.data.total}
				onOffset={onOffset}
				noun="contacts"
			/>
		</div>
	);
}

export function CompanyDetail({
	siteId,
	company,
	canAdminister,
	onDeleted,
	onOpenContact,
}: {
	siteId: string;
	company: CrmCompany;
	/** True only when this operator provably holds `admin`; see `canAdministerCrm`. */
	canAdminister: boolean;
	onDeleted: (contactsUnlinked: number) => void;
	onOpenContact: (contactId: string) => void;
}): ReactElement {
	const [editing, setEditing] = useState(false);
	const [rosterOffset, setRosterOffset] = useState(0);
	const roster = useCompanyContacts(siteId, company.id, rosterOffset);
	const contactCount = roster.data?.total ?? null;
	const update = useUpdateCompany(siteId, company.id);
	const remove = useDeleteCompany(siteId);

	if (editing) {
		return (
			<section className="surface space-y-3 rounded-xl p-4">
				<h3 className="font-semibold text-[color:var(--ink)] text-sm">Edit company</h3>
				<CompanyForm
					company={company}
					submitLabel="Save changes"
					pendingLabel="Saving…"
					isPending={update.isPending}
					error={update.error}
					onCancel={() => setEditing(false)}
					onSubmit={(fields) =>
						update.mutate(fields, { onSuccess: () => setEditing(false) })
					}
				/>
			</section>
		);
	}

	const survivors =
		contactCount === null
			? 'Its contacts are kept'
			: contactCount === 1
				? 'Its 1 contact is kept'
				: `Its ${contactCount} contacts are kept`;

	return (
		<section className="surface space-y-4 rounded-xl p-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<h3
						data-selectable
						className="truncate font-semibold text-[color:var(--ink)] text-base"
					>
						{company.name}
					</h3>
					<p data-chrome className="text-[color:var(--faint)] text-xs">
						Updated {formatDateTime(company.updated_at)}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-1.5">
					<StatusChip status={company.status} />
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="btn-ghost rounded-md px-2.5 py-1 font-medium text-xs transition"
					>
						Edit
					</button>
				</div>
			</div>

			<dl className="divide-y divide-[color:rgb(var(--border))]">
				<DetailRow label="Domain">{company.domain}</DetailRow>
				<DetailRow label="Notes">
					{company.notes ? (
						<span className="whitespace-pre-wrap">{company.notes}</span>
					) : null}
				</DetailRow>
				<DetailRow label="Created">{formatDateTime(company.created_at)}</DetailRow>
			</dl>

			<div className="space-y-2">
				<h4 className="flex items-center gap-1.5 font-semibold text-[color:var(--ink)] text-sm">
					<Users className="h-4 w-4" aria-hidden="true" />
					Contacts
				</h4>
				<Roster
					roster={roster}
					offset={rosterOffset}
					onOffset={setRosterOffset}
					onOpenContact={onOpenContact}
				/>
			</div>

			<div className="space-y-2">
				<h4 className="font-semibold text-[color:var(--ink)] text-sm">Analytics rollup</h4>
				<CompanyAnalyticsPanel siteId={siteId} companyId={company.id} />
			</div>

			<div className="space-y-2 border-[color:rgb(var(--border))] border-t pt-3">
				{canAdminister ? (
					<ConfirmDelete
						label="Delete company"
						confirmLabel="Delete company"
						busy={remove.isPending}
						consequence={`Deletes the company record only. ${survivors} — each one is unlinked and keeps “${company.name}” as free text. This cannot be undone.`}
						onConfirm={() =>
							remove.mutate(company.id, {
								onSuccess: (result) => onDeleted(result.contacts_unlinked),
							})
						}
					/>
				) : (
					<p data-chrome className="text-[color:var(--faint)] text-xs">
						Deleting a company needs the <strong>admin</strong> role on the team that
						owns this site.
					</p>
				)}
				<MutationStatus
					isPending={remove.isPending}
					error={remove.error}
					success={null}
					pendingLabel="Deleting…"
				/>
			</div>
		</section>
	);
}
