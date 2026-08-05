// One form for creating and for editing a company. As with contacts, every field is submitted on
// every save because the API reads `''` as "clear this" — the only way a form can unset a field.

import { type ReactElement, useState } from 'react';
import type { CrmFields } from '../../hooks/crm.js';
import { COMPANY_STATUSES, type CrmCompany } from '../../lib/crm.js';
import { BlockedReason, Field, FormControls, MutationStatus, Select } from '../settings/kit.js';

interface Draft {
	name: string;
	domain: string;
	status: string;
	notes: string;
}

export function CompanyForm({
	company,
	submitLabel,
	pendingLabel,
	onSubmit,
	onCancel,
	isPending,
	error,
}: {
	/** The company being edited, or null when creating. */
	company: CrmCompany | null;
	submitLabel: string;
	pendingLabel: string;
	onSubmit: (fields: CrmFields) => void;
	onCancel: () => void;
	isPending: boolean;
	error: unknown;
}): ReactElement {
	const [draft, setDraft] = useState<Draft>(() => ({
		name: company?.name ?? '',
		domain: company?.domain ?? '',
		status: company?.status ?? 'lead',
		notes: company?.notes ?? '',
	}));
	const set = (key: keyof Draft) => (value: string) =>
		setDraft((prev) => ({ ...prev, [key]: value }));
	// `companies.name` is NOT NULL and it is the display value: a company with no name is a row
	// nothing can refer to.
	const blocked = draft.name.trim() ? null : 'A company needs a name.';
	const idFor = (field: string) => `company-${company?.id ?? 'new'}-${field}`;

	return (
		<form
			className="surface-2 space-y-3 rounded-xl p-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (blocked || isPending) return;
				onSubmit({
					name: draft.name,
					domain: draft.domain,
					status: draft.status,
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
					placeholder="Acme Inc"
				/>
				<Field
					id={idFor('domain')}
					label="Domain"
					value={draft.domain}
					onChange={set('domain')}
					placeholder="acme.com"
					hint="Paste a URL if it is easier — it is stored as the bare host. www is a different host and is kept."
				/>
				<Select
					id={idFor('status')}
					label="Status"
					value={draft.status}
					onChange={set('status')}
				>
					{COMPANY_STATUSES.map((status) => (
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
			<MutationStatus isPending={isPending} error={error} pendingLabel={pendingLabel} />
		</form>
	);
}
