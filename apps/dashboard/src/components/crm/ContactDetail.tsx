// One contact: their record, an edit form, the consent-gated analytics link, and the two admin-only
// operations (data-subject export, erasure).
//
// THE ANALYTICS PANEL IS THE POINT OF THIS FILE. `linked: false` is rendered as an explicit
// not-linked state with its reason, never as a row of zeroes — "no consent record authorizes a link"
// and "this person did nothing" are different claims, and zeroes assert the second one. The API is
// careful to distinguish them; throwing that away in the render would undo it.

import { Download, Handshake, Link2Off, ScrollText } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useContactAnalytics, useDeleteContact, useUpdateContact } from '../../hooks/crm.js';
import { type CrmContact, linkReasonText } from '../../lib/crm.js';
import { formatDateTime } from '../../lib/datetime.js';
import { downloadContactExport } from '../../lib/download.js';
import { Skeleton } from '../StatusStates.js';
import { ConfirmDelete, MutationStatus } from '../settings/kit.js';
import { ContactForm } from './ContactForm.js';
import { ActivityFigures, CrmAccessNotice, DetailRow, StatusChip } from './shared.js';

function ContactAnalyticsPanel({
	siteId,
	contactId,
}: {
	siteId: string;
	contactId: string;
}): ReactElement {
	const analytics = useContactAnalytics(siteId, contactId);

	if (analytics.error) {
		return (
			<CrmAccessNotice
				error={analytics.error}
				subject="this contact's analytics"
				onRetry={() => void analytics.refetch()}
				retrying={analytics.isFetching}
			/>
		);
	}
	if (!analytics.data) return <Skeleton className="h-24 w-full" />;

	if (!analytics.data.linked) {
		return (
			<div className="alert-info flex items-start gap-2.5 rounded-lg p-3 text-sm">
				<Link2Off className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
				<div className="min-w-0">
					<p className="font-semibold">Not linked to analytics</p>
					<p className="mt-0.5 max-w-prose opacity-90">
						{linkReasonText(analytics.data.reason)}
					</p>
					<p className="mt-1 max-w-prose opacity-90">
						This is <strong>not</strong> a report of zero activity. Facet cannot
						attribute any events to this person at all, so it does not claim a number
						either way.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<ActivityFigures activity={analytics.data.activity} />
			<p data-chrome className="text-[color:var(--faint)] text-xs">
				Resolved through{' '}
				{analytics.data.windows === 1
					? '1 salt window'
					: `${analytics.data.windows} salt windows`}{' '}
				with a live consent record. The reach shortens on its own as retention purges older
				records.
			</p>
		</div>
	);
}

export function ContactDetail({
	siteId,
	contact,
	canAdminister,
	onDeleted,
	onOpenCompany,
	onOpenAudit,
	onViewDeals,
}: {
	siteId: string;
	contact: CrmContact;
	/** True only when this operator provably holds `admin`; see `canAdministerCrm`. */
	canAdminister: boolean;
	/** Reports what the erasure destroyed/unlinked, so the caller can say so. */
	onDeleted: (result: { consentRecordsErased: number; dealsUnlinked: number }) => void;
	/** Jump to the linked company. Omitted when there is nothing to jump to. */
	onOpenCompany?: (companyId: string) => void;
	/** Open the access log filtered to this person — "who has looked at this record", which is the
	 * question a subject-access request or a suspected leak asks, and one a whole-site log answers
	 * only by being read end to end. */
	onOpenAudit?: (targetId: string) => void;
	/** Switch to the Deals tab, filtered to deals naming this contact. */
	onViewDeals?: (contactId: string) => void;
}): ReactElement {
	const [editing, setEditing] = useState(false);
	const [saved, setSaved] = useState<string | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	const [exporting, setExporting] = useState(false);
	const update = useUpdateContact(siteId, contact.id);
	const remove = useDeleteContact(siteId);

	async function runExport(): Promise<void> {
		setExporting(true);
		setExportError(null);
		try {
			await downloadContactExport(siteId, contact.id);
		} catch (err) {
			setExportError(err instanceof Error ? err.message : 'export_failed');
		} finally {
			setExporting(false);
		}
	}

	if (editing) {
		return (
			<section className="surface space-y-3 rounded-xl p-4">
				<h3 className="font-semibold text-[color:var(--ink)] text-sm">Edit contact</h3>
				<ContactForm
					siteId={siteId}
					contact={contact}
					submitLabel="Save changes"
					pendingLabel="Saving…"
					isPending={update.isPending}
					error={update.error}
					onCancel={() => setEditing(false)}
					onSubmit={(fields) =>
						update.mutate(fields, {
							onSuccess: () => {
								setSaved('Contact updated.');
								setEditing(false);
							},
						})
					}
				/>
			</section>
		);
	}

	return (
		<section className="surface space-y-4 rounded-xl p-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<h3
						data-selectable
						className="truncate font-semibold text-[color:var(--ink)] text-base"
					>
						{contact.name || contact.email || contact.external_user_id || 'Contact'}
					</h3>
					<p data-chrome className="text-[color:var(--faint)] text-xs">
						Updated {formatDateTime(contact.updated_at)}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-1.5">
					<StatusChip status={contact.status} />
					{onViewDeals ? (
						<button
							type="button"
							onClick={() => onViewDeals(contact.id)}
							className="btn-ghost inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-xs transition"
						>
							<Handshake className="h-3.5 w-3.5" aria-hidden="true" />
							Deals
						</button>
					) : null}
					{onOpenAudit ? (
						<button
							type="button"
							onClick={() => onOpenAudit(contact.id)}
							className="btn-ghost inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-xs transition"
						>
							<ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
							Access log
						</button>
					) : null}
					<button
						type="button"
						onClick={() => {
							setSaved(null);
							setEditing(true);
						}}
						className="btn-ghost rounded-md px-2.5 py-1 font-medium text-xs transition"
					>
						Edit
					</button>
				</div>
			</div>

			<dl className="divide-y divide-[color:rgb(var(--border))]">
				<DetailRow label="Email">{contact.email}</DetailRow>
				<DetailRow label="Phone">{contact.phone}</DetailRow>
				<DetailRow label="Company">
					{contact.company ? (
						contact.company_id && onOpenCompany ? (
							<button
								type="button"
								data-selectable
								onClick={() => onOpenCompany(contact.company_id ?? '')}
								className="rounded text-left underline decoration-dotted underline-offset-2 hover:text-[color:var(--ink)]"
							>
								{contact.company}
							</button>
						) : (
							<>
								{contact.company}
								{contact.company_id ? null : (
									<span
										data-chrome
										className="ml-1.5 text-[color:var(--faint)] text-xs"
									>
										(free text, not linked)
									</span>
								)}
							</>
						)
					) : null}
				</DetailRow>
				<DetailRow label="Job title">{contact.title}</DetailRow>
				<DetailRow label="Source">{contact.source}</DetailRow>
				<DetailRow label="External user id">
					{contact.external_user_id ? (
						<code className="font-mono text-xs">{contact.external_user_id}</code>
					) : null}
				</DetailRow>
				<DetailRow label="Notes">
					{contact.notes ? (
						<span className="whitespace-pre-wrap">{contact.notes}</span>
					) : null}
				</DetailRow>
				<DetailRow label="Created">{formatDateTime(contact.created_at)}</DetailRow>
			</dl>

			<MutationStatus isPending={false} error={null} success={saved} />

			<div className="space-y-2">
				<h4 className="font-semibold text-[color:var(--ink)] text-sm">Analytics</h4>
				<ContactAnalyticsPanel siteId={siteId} contactId={contact.id} />
			</div>

			<div className="space-y-2 border-[color:rgb(var(--border))] border-t pt-3">
				{canAdminister ? (
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={() => void runExport()}
							disabled={exporting}
							className="btn-ghost inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-xs transition disabled:opacity-60"
						>
							<Download className="h-3.5 w-3.5" aria-hidden="true" />
							{exporting ? 'Preparing export…' : 'Export this person’s data'}
						</button>
						<ConfirmDelete
							label="Delete contact"
							confirmLabel="Delete permanently"
							busy={remove.isPending}
							consequence="Erases this contact and their consent records, and unlinks any deal naming them. Their analytics events stay, permanently unlinkable. This cannot be undone."
							onConfirm={() =>
								remove.mutate(contact.id, {
									onSuccess: (result) =>
										onDeleted({
											consentRecordsErased: result.consent_records_erased,
											dealsUnlinked: result.deals_unlinked,
										}),
								})
							}
						/>
					</div>
				) : (
					<p data-chrome className="text-[color:var(--faint)] text-xs">
						Exporting and deleting a contact need the <strong>admin</strong> role on the
						team that owns this site.
					</p>
				)}
				{exportError ? (
					<p
						role="alert"
						className="alert-error rounded-md px-2 py-1 font-medium text-xs"
					>
						Export failed: {exportError}
					</p>
				) : null}
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
