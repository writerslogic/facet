import { ScrollText } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useCompany, useContact, useDeleteDeal, useUpdateDeal } from '../../hooks/crm.js';
import { type CrmDeal, formatMoney } from '../../lib/crm.js';
import { formatDateTime } from '../../lib/datetime.js';
import { ConfirmDelete, MutationStatus } from '../settings/kit.js';
import { DealForm } from './DealForm.js';
import { DetailRow, StatusChip } from './shared.js';

/** The linked company's current name, or the raw id while it loads — never blank, since a deal
 * pointing at a real `company_id` always resolves to something. */
function CompanyLink({
	siteId,
	companyId,
	onOpen,
}: {
	siteId: string;
	companyId: string;
	onOpen?: (companyId: string) => void;
}): ReactElement {
	const company = useCompany(siteId, companyId);
	const label = company.data?.company.name ?? companyId;
	if (!onOpen) return <>{label}</>;
	return (
		<button
			type="button"
			data-selectable
			onClick={() => onOpen(companyId)}
			className="rounded text-left underline decoration-dotted underline-offset-2 hover:text-[color:var(--ink)]"
		>
			{label}
		</button>
	);
}

/** The linked contact's display name, or the raw id while it loads. Mirrors `CompanyLink`. */
function ContactLink({
	siteId,
	contactId,
	onOpen,
}: {
	siteId: string;
	contactId: string;
	onOpen?: (contactId: string) => void;
}): ReactElement {
	const contact = useContact(siteId, contactId);
	const c = contact.data?.contact;
	const label = c ? c.name || c.email || c.external_user_id || contactId : contactId;
	if (!onOpen) return <>{label}</>;
	return (
		<button
			type="button"
			data-selectable
			onClick={() => onOpen(contactId)}
			className="rounded text-left underline decoration-dotted underline-offset-2 hover:text-[color:var(--ink)]"
		>
			{label}
		</button>
	);
}

export function DealDetail({
	siteId,
	deal,
	canAdminister,
	onDeleted,
	onOpenCompany,
	onOpenContact,
	onOpenAudit,
}: {
	siteId: string;
	deal: CrmDeal;
	/** True only when this operator provably holds `admin`; see `canAdministerCrm`. */
	canAdminister: boolean;
	onDeleted: () => void;
	/** Jump to the linked company or contact. Omitted where there is nothing to jump to. */
	onOpenCompany?: (companyId: string) => void;
	onOpenContact?: (contactId: string) => void;
	/** Open the access log filtered to this deal — mirrors ContactDetail/CompanyDetail. */
	onOpenAudit?: (targetId: string) => void;
}): ReactElement {
	const [editing, setEditing] = useState(false);
	const [saved, setSaved] = useState<string | null>(null);
	const update = useUpdateDeal(siteId, deal.id);
	const remove = useDeleteDeal(siteId);

	if (editing) {
		return (
			<section className="surface space-y-3 rounded-xl p-4">
				<h3 className="font-semibold text-[color:var(--ink)] text-sm">Edit deal</h3>
				<DealForm
					siteId={siteId}
					deal={deal}
					submitLabel="Save changes"
					pendingLabel="Saving…"
					isPending={update.isPending}
					error={update.error}
					onCancel={() => setEditing(false)}
					onSubmit={(fields) =>
						update.mutate(fields, {
							onSuccess: () => {
								setSaved('Deal updated.');
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
						{deal.name}
					</h3>
					<p data-chrome className="text-[color:var(--faint)] text-xs">
						Updated {formatDateTime(deal.updated_at)}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-1.5">
					<StatusChip status={deal.stage} />
					{onOpenAudit ? (
						<button
							type="button"
							onClick={() => onOpenAudit(deal.id)}
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
				<DetailRow label="Value">
					{deal.value != null ? formatMoney(deal.value, deal.currency) : null}
				</DetailRow>
				<DetailRow label="Expected close">
					{deal.expected_close_date != null
						? formatDateTime(deal.expected_close_date)
						: null}
				</DetailRow>
				<DetailRow label="Company">
					{deal.company_id ? (
						<CompanyLink
							siteId={siteId}
							companyId={deal.company_id}
							onOpen={onOpenCompany}
						/>
					) : null}
				</DetailRow>
				<DetailRow label="Contact">
					{deal.contact_id ? (
						<ContactLink
							siteId={siteId}
							contactId={deal.contact_id}
							onOpen={onOpenContact}
						/>
					) : null}
				</DetailRow>
				<DetailRow label="Notes">
					{deal.notes ? <span className="whitespace-pre-wrap">{deal.notes}</span> : null}
				</DetailRow>
				<DetailRow label="Created">{formatDateTime(deal.created_at)}</DetailRow>
			</dl>

			<MutationStatus isPending={false} error={null} success={saved} />

			<div className="space-y-2 border-[color:rgb(var(--border))] border-t pt-3">
				{canAdminister ? (
					<ConfirmDelete
						label="Delete deal"
						confirmLabel="Delete permanently"
						busy={remove.isPending}
						consequence="Deletes this deal. This cannot be undone."
						onConfirm={() => remove.mutate(deal.id, { onSuccess: onDeleted })}
					/>
				) : (
					<p data-chrome className="text-[color:var(--faint)] text-xs">
						Deleting a deal needs the <strong>admin</strong> role on the team that owns
						this site.
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
