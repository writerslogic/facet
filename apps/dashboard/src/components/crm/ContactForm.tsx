// One form for creating and for editing a contact — the same fields, the same validation, and the
// same handling of the employer pair, so a create and an edit can never drift apart.
//
// `company` and `company_id` are ONE fact recorded two ways, and the API rejects a request that
// supplies both. Rather than surface `company_conflict` after a round trip, the free-text box is
// disabled whenever a company is linked and the submitted body always clears the other side. Every
// field is sent on every submit, including the empty ones: the API reads `''` as "clear this", which
// is the only way a form can unset a field it previously wrote.

import { type ReactElement, useState } from 'react';
import type { CrmFields } from '../../hooks/crm.js';
import { useCompanyOptions } from '../../hooks/crm.js';
import type { CrmContact } from '../../lib/crm.js';
import { CONTACT_STATUSES } from '../../lib/crm.js';
import { BlockedReason, Field, FormControls, MutationStatus, Select } from '../settings/kit.js';

type Draft = {
	name: string;
	email: string;
	external_user_id: string;
	phone: string;
	title: string;
	source: string;
	status: string;
	company: string;
	company_id: string;
	notes: string;
};

function draftFrom(contact: CrmContact | null): Draft {
	return {
		name: contact?.name ?? '',
		email: contact?.email ?? '',
		external_user_id: contact?.external_user_id ?? '',
		phone: contact?.phone ?? '',
		title: contact?.title ?? '',
		source: contact?.source ?? '',
		status: contact?.status ?? 'lead',
		// `company` is the RESOLVED name, so it also holds a linked company's name. Showing that in
		// the free-text box would re-submit it as free text; it belongs there only when unlinked.
		company: contact?.company_id ? '' : (contact?.company ?? ''),
		company_id: contact?.company_id ?? '',
		notes: contact?.notes ?? '',
	};
}

/** The API refuses a contact with no email, no external id and no name: a row nothing can ever
 * match, dedupe or erase on request. Say so before the request rather than after it. */
function blockedReason(draft: Draft): string | null {
	if (!draft.name.trim() && !draft.email.trim() && !draft.external_user_id.trim()) {
		return 'Give at least a name, an email, or an external user id.';
	}
	return null;
}

export function ContactForm({
	siteId,
	contact,
	submitLabel,
	pendingLabel,
	onSubmit,
	onCancel,
	isPending,
	error,
}: {
	siteId: string;
	/** The contact being edited, or null when creating. */
	contact: CrmContact | null;
	submitLabel: string;
	pendingLabel: string;
	onSubmit: (fields: CrmFields) => void;
	onCancel: () => void;
	isPending: boolean;
	error: unknown;
}): ReactElement {
	const [draft, setDraft] = useState<Draft>(() => draftFrom(contact));
	const options = useCompanyOptions(siteId);
	const companies = options.data?.companies ?? [];
	const optionsTruncated = (options.data?.total ?? 0) > companies.length;
	const set = (key: keyof Draft) => (value: string) =>
		setDraft((prev) => ({ ...prev, [key]: value }));
	const blocked = blockedReason(draft);
	const idFor = (field: string) => `contact-${contact?.id ?? 'new'}-${field}`;

	return (
		<form
			className="surface-2 space-y-3 rounded-xl p-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (blocked || isPending) return;
				const linked = draft.company_id.trim();
				onSubmit({
					name: draft.name,
					email: draft.email,
					external_user_id: draft.external_user_id,
					phone: draft.phone,
					title: draft.title,
					source: draft.source,
					status: draft.status,
					notes: draft.notes,
					// Exactly one side of the employer pair carries a value; the other is cleared.
					company_id: linked,
					company: linked ? '' : draft.company,
				});
			}}
		>
			<FormControls busy={isPending} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field
					id={idFor('name')}
					label="Name"
					value={draft.name}
					onChange={set('name')}
					placeholder="Ada Lovelace"
				/>
				<Field
					id={idFor('email')}
					label="Email"
					type="email"
					value={draft.email}
					onChange={set('email')}
					placeholder="ada@example.com"
				/>
				<Field
					id={idFor('external_user_id')}
					label="External user id"
					value={draft.external_user_id}
					onChange={set('external_user_id')}
					hint="Your own id for this person. The only thing that can ever link them to analytics, and only through an active signed consent record."
				/>
				<Field
					id={idFor('phone')}
					label="Phone"
					value={draft.phone}
					onChange={set('phone')}
				/>
				<Select
					id={idFor('company_id')}
					label="Linked company"
					value={draft.company_id}
					onChange={set('company_id')}
					hint={
						optionsTruncated
							? `Showing the first ${companies.length} companies. Use the free-text box for one that is not listed.`
							: undefined
					}
				>
					<option value="">— none —</option>
					{companies.map((company) => (
						<option key={company.id} value={company.id}>
							{company.name}
						</option>
					))}
				</Select>
				<Field
					id={idFor('company')}
					label="Company (free text)"
					value={draft.company_id ? '' : draft.company}
					onChange={set('company')}
					disabled={Boolean(draft.company_id)}
					hint={
						draft.company_id
							? 'Unavailable while a company is linked — a contact has one employer, recorded one way.'
							: 'For a company with no record in Facet.'
					}
				/>
				<Field
					id={idFor('title')}
					label="Job title"
					value={draft.title}
					onChange={set('title')}
				/>
				<Field
					id={idFor('source')}
					label="Source"
					value={draft.source}
					onChange={set('source')}
					placeholder="webinar, referral, …"
				/>
				<Select
					id={idFor('status')}
					label="Status"
					value={draft.status}
					onChange={set('status')}
				>
					{CONTACT_STATUSES.map((status) => (
						<option key={status} value={status}>
							{status}
						</option>
					))}
				</Select>
				<div className="min-w-0 sm:col-span-2">
					<label
						htmlFor={idFor('notes')}
						className="block font-medium text-[color:var(--muted)] text-xs"
					>
						Notes
					</label>
					<textarea
						id={idFor('notes')}
						value={draft.notes}
						onChange={(e) => set('notes')(e.target.value)}
						rows={3}
						className="input mt-1 block w-full rounded-lg px-3 py-1.5 text-sm"
					/>
				</div>
			</FormControls>
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="submit"
					disabled={Boolean(blocked) || isPending}
					className="btn-accent rounded-lg px-3.5 py-1.5 font-medium text-sm transition disabled:cursor-not-allowed disabled:opacity-60"
				>
					{submitLabel}
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="btn-ghost rounded-lg px-3 py-1.5 font-medium text-sm transition"
				>
					Cancel
				</button>
				<BlockedReason reason={blocked} />
			</div>
			<MutationStatus
				isPending={isPending}
				error={error}
				success={null}
				pendingLabel={pendingLabel}
			/>
		</form>
	);
}
