// Flags panel: create/edit a feature flag (key, name, type, default variant, weighted variants),
// toggle enabled, list with a variant + rules summary, and delete. Variant weights are basis points
// that must sum to exactly 10000; the server rejects otherwise and its error is surfaced inline.
//
// Editing loads a flag into the same form that creates one, so the form states which flag it is
// editing — otherwise "Save flag" is indistinguishable from "Create flag" once the row has scrolled
// out of view, and a stray edit rewrites a live flag.

import type { FlagInput, FlagRecord, FlagVariant } from '@facet/shared';
import { Pencil, Plus, X } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useAdminFlags, useCreateFlag, useDeleteFlag, useUpdateFlag } from '../../hooks/flags.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import {
	BlockedReason,
	ConfirmDelete,
	Field,
	FormControls,
	MutationStatus,
	Panel,
	Select,
} from './kit.js';

const booleanVariants = (): FlagVariant[] => [
	{ key: 'on', weight: 5000 },
	{ key: 'off', weight: 5000 },
];

const emptyVariant = (): FlagVariant => ({ key: '', weight: 0 });

interface DraftState {
	editingId: string | null;
	editingName: string;
	flagKey: string;
	name: string;
	type: 'boolean' | 'multivariate';
	defaultVariant: string;
	variants: FlagVariant[];
}

const emptyDraft = (): DraftState => ({
	editingId: null,
	editingName: '',
	flagKey: '',
	name: '',
	type: 'boolean',
	defaultVariant: 'off',
	variants: booleanVariants(),
});

export function FlagsPanel({
	token,
	siteId,
}: {
	token: string;
	siteId: string;
}): ReactElement {
	const flags = useAdminFlags(token, siteId);
	const create = useCreateFlag(token, siteId);
	const update = useUpdateFlag(token, siteId);
	const remove = useDeleteFlag(token, siteId);

	const [draft, setDraft] = useState<DraftState>(emptyDraft);
	// Carry a flag's existing targeting rules through an edit so a PATCH does not silently drop them.
	const [rulesById, setRulesById] = useState<Record<string, FlagRecord['rules']>>({});

	const filledVariants = draft.variants.filter((v) => v.key.trim());
	const weightSum = filledVariants.reduce(
		(sum, v) => sum + (Number.isFinite(v.weight) ? v.weight : 0),
		0,
	);
	const keys = filledVariants.map((v) => v.key.trim());
	const minVariants = draft.type === 'boolean' ? 2 : 1;
	const canSubmit = Boolean(
		draft.flagKey.trim() &&
			draft.name.trim() &&
			filledVariants.length >= minVariants &&
			weightSum === 10000 &&
			keys.includes(draft.defaultVariant),
	);
	// The weight rule is the one people hit; naming it beats a dead button next to a red sum.
	const blocked = canSubmit
		? null
		: !draft.flagKey.trim()
			? 'Enter a flag key.'
			: !draft.name.trim()
				? 'Enter a name.'
				: filledVariants.length < minVariants
					? `Name at least ${minVariants} variant${minVariants === 1 ? '' : 's'}.`
					: weightSum !== 10000
						? `Variant weights must sum to exactly 10000 (currently ${weightSum}).`
						: 'Pick a default variant from the variants you defined.';

	function updateVariant(index: number, patch: Partial<FlagVariant>): void {
		setDraft((prev) => ({
			...prev,
			variants: prev.variants.map((v, i) => (i === index ? { ...v, ...patch } : v)),
		}));
	}

	function onType(type: 'boolean' | 'multivariate'): void {
		setDraft((prev) =>
			type === 'boolean'
				? {
						...prev,
						type,
						variants: booleanVariants(),
						defaultVariant: 'off',
					}
				: { ...prev, type },
		);
	}

	function resetDraft(): void {
		setDraft(emptyDraft());
	}

	function startEdit(flag: FlagRecord): void {
		setDraft({
			editingId: flag.id,
			editingName: flag.name,
			flagKey: flag.flag_key,
			name: flag.name,
			type: flag.type,
			defaultVariant: flag.default_variant,
			variants: flag.variants.map((v) => ({
				key: v.key,
				weight: v.weight,
			})),
		});
		setRulesById((prev) => ({ ...prev, [flag.id]: flag.rules }));
	}

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		const body: FlagInput = {
			site_id: siteId,
			flag_key: draft.flagKey.trim(),
			name: draft.name.trim(),
			type: draft.type,
			default_variant: draft.defaultVariant,
			variants: filledVariants.map((v) => ({
				key: v.key.trim(),
				weight: Number.isFinite(v.weight) ? v.weight : 0,
			})),
			rules: draft.editingId ? (rulesById[draft.editingId] ?? []) : [],
		};
		if (draft.editingId) {
			update.mutate({ id: draft.editingId, body }, { onSuccess: resetDraft });
		} else {
			create.mutate(body, { onSuccess: resetDraft });
		}
	}

	function toggleEnabled(flag: FlagRecord): void {
		update.mutate({
			id: flag.id,
			body: {
				site_id: siteId,
				flag_key: flag.flag_key,
				name: flag.name,
				type: flag.type,
				enabled: !flag.enabled,
				default_variant: flag.default_variant,
				variants: flag.variants.map((v) => ({
					key: v.key,
					weight: v.weight,
				})),
				rules: flag.rules,
			},
		});
	}

	const mutating = draft.editingId ? update : create;

	return (
		<Panel
			title="Feature flags"
			description="Evaluated live by your app. Weights are basis points out of 10000, so 2500 is 25% of traffic."
		>
			{draft.editingId ? (
				<p className="alert-info mb-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs">
					<Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					<span>
						Editing <strong>{draft.editingName}</strong>. Saving overwrites the live
						flag; its targeting rules are preserved.
					</span>
				</p>
			) : null}
			<form onSubmit={onSubmit}>
				<FormControls busy={mutating.isPending} className="space-y-3">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field
							id="flag-key"
							label="Flag key"
							value={draft.flagKey}
							onChange={(flagKey) => setDraft((prev) => ({ ...prev, flagKey }))}
							placeholder="new_checkout"
						/>
						<Field
							id="flag-name"
							label="Name"
							value={draft.name}
							onChange={(name) => setDraft((prev) => ({ ...prev, name }))}
							placeholder="New checkout"
						/>
					</div>

					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Select
							id="flag-type"
							label="Type"
							value={draft.type}
							onChange={(next) => onType(next as 'boolean' | 'multivariate')}
						>
							<option value="boolean">boolean</option>
							<option value="multivariate">multivariate</option>
						</Select>
						<Select
							id="flag-default"
							label="Default variant"
							value={draft.defaultVariant}
							onChange={(defaultVariant) =>
								setDraft((prev) => ({ ...prev, defaultVariant }))
							}
							hint="Served when the flag is off or a visitor is not bucketed."
						>
							{keys.length === 0 ? <option value="">(define variants)</option> : null}
							{keys.map((k) => (
								<option key={k} value={k}>
									{k}
								</option>
							))}
						</Select>
					</div>

					<fieldset className="space-y-2">
						<legend className="font-medium text-[color:var(--muted)] text-xs">
							Variants (weights are basis points, must sum to 10000)
						</legend>
						{draft.variants.map((variant, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: variants are positional
							<div key={index} className="flex items-center gap-2">
								<label className="sr-only" htmlFor={`flag-variant-key-${index}`}>
									Variant {index + 1} key
								</label>
								<input
									id={`flag-variant-key-${index}`}
									type="text"
									value={variant.key}
									onChange={(e) =>
										updateVariant(index, {
											key: e.target.value,
										})
									}
									placeholder={`variant ${index + 1}`}
									className="input min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm"
								/>
								<label className="sr-only" htmlFor={`flag-variant-weight-${index}`}>
									Variant {index + 1} weight
								</label>
								<input
									id={`flag-variant-weight-${index}`}
									type="number"
									min={0}
									max={10000}
									step={1}
									value={variant.weight}
									onChange={(e) =>
										updateVariant(index, {
											weight: Number(e.target.value),
										})
									}
									className="input w-24 rounded-lg px-3 py-1.5 text-sm"
								/>
								{draft.variants.length > 2 ? (
									<button
										type="button"
										onClick={() =>
											setDraft((prev) => ({
												...prev,
												variants: prev.variants.filter(
													(_, i) => i !== index,
												),
											}))
										}
										aria-label={`Remove variant ${index + 1}`}
										className="rounded-md p-1 text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
									>
										<X className="h-4 w-4" aria-hidden="true" />
									</button>
								) : null}
							</div>
						))}
						<div className="flex items-center justify-between">
							{draft.type === 'multivariate' ? (
								<button
									type="button"
									onClick={() =>
										setDraft((prev) => ({
											...prev,
											variants: [...prev.variants, emptyVariant()],
										}))
									}
									className="inline-flex items-center gap-1 font-medium text-[color:var(--chip-ink)] text-xs"
								>
									<Plus className="h-3.5 w-3.5" aria-hidden="true" />
									Add variant
								</button>
							) : (
								<span />
							)}
							<span
								className={
									weightSum === 10000
										? 'text-pos text-xs tabular-nums'
										: 'text-neg text-xs tabular-nums'
								}
							>
								Σ {weightSum} / 10000
							</span>
						</div>
					</fieldset>

					<div className="space-y-1">
						<div className="flex items-center gap-2">
							<button
								type="submit"
								disabled={!canSubmit}
								className="btn-accent rounded-lg px-4 py-1.5 text-sm transition"
							>
								{draft.editingId ? 'Save flag' : 'Create flag'}
							</button>
							{draft.editingId ? (
								<button
									type="button"
									onClick={resetDraft}
									className="btn-ghost rounded-lg px-3 py-1.5 font-medium text-sm transition"
								>
									Cancel
								</button>
							) : null}
						</div>
						<BlockedReason reason={blocked} />
					</div>
				</FormControls>
			</form>
			<MutationStatus
				isPending={mutating.isPending}
				error={mutating.error}
				success={mutating.isSuccess ? 'Flag saved.' : null}
				pendingLabel="Saving flag…"
			/>

			<div className="mt-5">
				{flags.isLoading ? (
					<CardSkeletons count={2} />
				) : flags.error ? (
					<ErrorState
						message="Could not load flags"
						detail={flags.error instanceof Error ? flags.error.message : null}
					/>
				) : flags.data && flags.data.flags.length > 0 ? (
					<ul className="divide-y divide-[color:rgb(var(--border))]">
						{flags.data.flags.map((flag) => (
							<li
								key={flag.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-[color:var(--ink)]">
										{flag.name}{' '}
										<span className="font-normal text-[color:var(--muted)]">
											v{flag.version}
										</span>
									</p>
									<p className="truncate text-[color:var(--muted)] text-xs">
										{flag.flag_key} · {flag.type} ·{' '}
										{flag.variants
											.map((v) => `${v.key} ${v.weight}`)
											.join(', ')}
										{flag.rules.length > 0
											? ` · ${flag.rules.length} rule(s)`
											: ''}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<label className="flex items-center gap-1.5 text-[color:var(--muted)] text-xs">
										<input
											type="checkbox"
											checked={flag.enabled}
											disabled={update.isPending}
											onChange={() => toggleEnabled(flag)}
											aria-label={`${flag.enabled ? 'Disable' : 'Enable'} ${flag.name}`}
										/>
										{flag.enabled ? 'On' : 'Off'}
									</label>
									<button
										type="button"
										onClick={() => startEdit(flag)}
										className="btn-ghost rounded-md px-2 py-1 font-medium text-[color:var(--muted)] text-xs transition"
									>
										Edit
									</button>
									<ConfirmDelete
										onConfirm={() => remove.mutate(flag.id)}
										consequence={`Delete "${flag.name}"? Apps evaluating it fall back to their own default.`}
										busy={remove.isPending}
									/>
								</div>
							</li>
						))}
					</ul>
				) : (
					<EmptyState title="No flags yet">
						Create a feature flag to roll out changes gradually.
					</EmptyState>
				)}
			</div>
			<MutationStatus
				isPending={remove.isPending}
				error={remove.error}
				pendingLabel="Deleting flag…"
			/>
		</Panel>
	);
}
