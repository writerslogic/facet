// One form for creating and for editing a deal — the same fields, the same validation, matching
// ContactForm/CompanyForm.
//
// `value` and `currency` are one fact recorded in two columns, same as the employer pair on a
// contact: the API rejects a request that sets one without the other, so the form disables `currency`
// once `value` is cleared rather than surface `deal_value_needs_currency` after a round trip.

import { type ReactElement, useState } from 'react';
import type { CrmFields } from '../../hooks/crm.js';
import { useCompanyOptions, useContactOptions } from '../../hooks/crm.js';
import type { CrmDeal } from '../../lib/crm.js';
import { DEAL_STAGES } from '../../lib/crm.js';
import { BlockedReason, Field, FormControls, MutationStatus, Select } from '../settings/kit.js';

type Draft = {
	name: string;
	stage: string;
	/** Whole units (dollars, pounds, …), as typed — converted to cents only on submit. */
	value: string;
	currency: string;
	/** `yyyy-mm-dd`, as an `<input type="date">` reads and writes — converted to Unix ms on submit. */
	expected_close_date: string;
	company_id: string;
	contact_id: string;
	notes: string;
};

function draftFrom(deal: CrmDeal | null): Draft {
	return {
		name: deal?.name ?? '',
		stage: deal?.stage ?? 'lead',
		value: deal?.value == null ? '' : String(deal.value / 100),
		currency: deal?.currency ?? '',
		expected_close_date:
			deal?.expected_close_date == null
				? ''
				: new Date(deal.expected_close_date).toISOString().slice(0, 10),
		company_id: deal?.company_id ?? '',
		contact_id: deal?.contact_id ?? '',
		notes: deal?.notes ?? '',
	};
}

/** The two client-checkable rules the API enforces: a name, and the value/currency pair. Everything
 * else (an unknown `company_id`/`contact_id`) can only be found out from the response. */
function blockedReason(draft: Draft): string | null {
	if (!draft.name.trim()) return 'Give the deal a name.';
	if (Boolean(draft.value.trim()) !== Boolean(draft.currency.trim())) {
		return 'A value needs a currency, and a currency needs a value — set both or neither.';
	}
	if (draft.value.trim() && !Number.isFinite(Number(draft.value))) {
		return 'Value must be a number.';
	}
	return null;
}

export function DealForm({
	siteId,
	deal,
	submitLabel,
	pendingLabel,
	onSubmit,
	onCancel,
	isPending,
	error,
	success,
}: {
	siteId: string;
	/** The deal being edited, or null when creating. */
	deal: CrmDeal | null;
	submitLabel: string;
	pendingLabel: string;
	onSubmit: (fields: CrmFields) => void;
	onCancel: () => void;
	isPending: boolean;
	error: unknown;
	success?: string | null;
}): ReactElement {
	const [draft, setDraft] = useState<Draft>(() => draftFrom(deal));
	const companyOptions = useCompanyOptions(siteId);
	const companies = companyOptions.data?.companies ?? [];
	const companiesTruncated = (companyOptions.data?.total ?? 0) > companies.length;
	const contactOptions = useContactOptions(siteId);
	const contacts = contactOptions.data?.contacts ?? [];
	const contactsTruncated = (contactOptions.data?.total ?? 0) > contacts.length;
	const set = (key: keyof Draft) => (value: string) =>
		setDraft((prev) => ({ ...prev, [key]: value }));
	const blocked = blockedReason(draft);
	const idFor = (field: string) => `deal-${deal?.id ?? 'new'}-${field}`;

	return (
		<form
			className="surface-2 space-y-3 rounded-xl p-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (blocked || isPending) return;
				const value = draft.value.trim();
				const date = draft.expected_close_date.trim();
				onSubmit({
					name: draft.name,
					stage: draft.stage,
					value: value ? String(Math.round(Number(value) * 100)) : '',
					// Uppercased here too, not just server-side — so a saved draft round-trips
					// unchanged instead of showing lowercase until the next fetch.
					currency: value ? draft.currency.trim().toUpperCase() : '',
					expected_close_date: date
						? String(new Date(`${date}T00:00:00Z`).getTime())
						: '',
					company_id: draft.company_id,
					contact_id: draft.contact_id,
					notes: draft.notes,
				});
			}}
		>
			<FormControls busy={isPending} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field
					id={idFor('name')}
					label="Name"
					value={draft.name}
					onChange={set('name')}
					placeholder="Acme Inc — annual plan"
				/>
				<Select
					id={idFor('stage')}
					label="Stage"
					value={draft.stage}
					onChange={set('stage')}
				>
					{DEAL_STAGES.map((stage) => (
						<option key={stage} value={stage}>
							{stage}
						</option>
					))}
				</Select>
				<Field
					id={idFor('value')}
					label="Value"
					type="number"
					value={draft.value}
					onChange={set('value')}
					placeholder="4900"
					hint="Whole units, e.g. 49 for $49.00."
				/>
				<Field
					id={idFor('currency')}
					label="Currency"
					value={draft.currency}
					onChange={set('currency')}
					placeholder="USD"
					disabled={!draft.value.trim()}
					hint={
						draft.value.trim()
							? 'Three-letter ISO 4217 code.'
							: 'Unavailable until a value is set.'
					}
				/>
				<Field
					id={idFor('expected_close_date')}
					label="Expected close date"
					type="date"
					value={draft.expected_close_date}
					onChange={set('expected_close_date')}
				/>
				<Select
					id={idFor('company_id')}
					label="Company"
					value={draft.company_id}
					onChange={set('company_id')}
					hint={
						companiesTruncated
							? `Showing the first ${companies.length} companies.`
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
				<Select
					id={idFor('contact_id')}
					label="Contact"
					value={draft.contact_id}
					onChange={set('contact_id')}
					hint={
						contactsTruncated
							? `Showing the first ${contacts.length} contacts.`
							: undefined
					}
				>
					<option value="">— none —</option>
					{contacts.map((contact) => (
						<option key={contact.id} value={contact.id}>
							{contact.name ||
								contact.email ||
								contact.external_user_id ||
								contact.id}
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
				success={success ?? null}
				pendingLabel={pendingLabel}
			/>
		</form>
	);
}
