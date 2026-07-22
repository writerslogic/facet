// Flags panel: create/edit a feature flag (key, name, type, default variant, weighted variants),
// toggle enabled, list with a variant + rules summary, and delete. Variant weights are basis points
// that must sum to exactly 10000; the server rejects otherwise and its error is surfaced inline.

import type { FlagInput, FlagRecord, FlagVariant } from '@facet/shared';
import { Plus, X } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useAdminFlags, useCreateFlag, useDeleteFlag, useUpdateFlag } from '../../hooks/flags.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import { ConfirmDelete, Field, MutationStatus, Panel } from './kit.js';

const booleanVariants = (): FlagVariant[] => [
	{ key: 'on', weight: 5000 },
	{ key: 'off', weight: 5000 },
];

const emptyVariant = (): FlagVariant => ({ key: '', weight: 0 });

interface DraftState {
	editingId: string | null;
	flagKey: string;
	name: string;
	type: 'boolean' | 'multivariate';
	defaultVariant: string;
	variants: FlagVariant[];
}

const emptyDraft = (): DraftState => ({
	editingId: null,
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
	const canSubmit =
		draft.flagKey.trim() &&
		draft.name.trim() &&
		filledVariants.length >= (draft.type === 'boolean' ? 2 : 1) &&
		weightSum === 10000 &&
		keys.includes(draft.defaultVariant);

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
		<Panel title="Feature flags">
			<form onSubmit={onSubmit} className="space-y-3">
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
					<div>
						<label
							htmlFor="flag-type"
							className="block text-xs font-medium text-neutral-600"
						>
							Type
						</label>
						<select
							id="flag-type"
							value={draft.type}
							onChange={(e) => onType(e.target.value as 'boolean' | 'multivariate')}
							className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
						>
							<option value="boolean">boolean</option>
							<option value="multivariate">multivariate</option>
						</select>
					</div>
					<div>
						<label
							htmlFor="flag-default"
							className="block text-xs font-medium text-neutral-600"
						>
							Default variant
						</label>
						<select
							id="flag-default"
							value={draft.defaultVariant}
							onChange={(e) =>
								setDraft((prev) => ({
									...prev,
									defaultVariant: e.target.value,
								}))
							}
							className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
						>
							{keys.length === 0 ? <option value="">(define variants)</option> : null}
							{keys.map((k) => (
								<option key={k} value={k}>
									{k}
								</option>
							))}
						</select>
					</div>
				</div>

				<fieldset className="space-y-2">
					<legend className="text-xs font-medium text-neutral-600">
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
								className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
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
								className="w-24 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
							/>
							{draft.variants.length > 2 ? (
								<button
									type="button"
									onClick={() =>
										setDraft((prev) => ({
											...prev,
											variants: prev.variants.filter((_, i) => i !== index),
										}))
									}
									aria-label={`Remove variant ${index + 1}`}
									className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
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
								className="inline-flex items-center gap-1 text-xs font-medium text-accent-600 hover:text-accent-800"
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
									? 'text-xs tabular-nums text-emerald-600'
									: 'text-xs tabular-nums text-red-600'
							}
						>
							Σ {weightSum} / 10000
						</span>
					</div>
				</fieldset>

				<div className="flex items-center gap-2">
					<button
						type="submit"
						disabled={mutating.isPending || !canSubmit}
						className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
					>
						{draft.editingId ? 'Save flag' : 'Create flag'}
					</button>
					{draft.editingId ? (
						<button
							type="button"
							onClick={resetDraft}
							className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100"
						>
							Cancel
						</button>
					) : null}
				</div>
			</form>
			<MutationStatus
				isPending={mutating.isPending}
				error={mutating.error}
				success={mutating.isSuccess ? 'Flag saved.' : null}
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
					<ul className="divide-y divide-neutral-100">
						{flags.data.flags.map((flag) => (
							<li
								key={flag.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-neutral-800">
										{flag.name}{' '}
										<span className="font-normal text-neutral-400">
											v{flag.version}
										</span>
									</p>
									<p className="truncate text-xs text-neutral-400">
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
									<label className="flex items-center gap-1.5 text-xs text-neutral-500">
										<input
											type="checkbox"
											checked={flag.enabled}
											onChange={() => toggleEnabled(flag)}
											aria-label={`${flag.enabled ? 'Disable' : 'Enable'} ${flag.name}`}
										/>
										{flag.enabled ? 'On' : 'Off'}
									</label>
									<button
										type="button"
										onClick={() => startEdit(flag)}
										className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800"
									>
										Edit
									</button>
									<ConfirmDelete onConfirm={() => remove.mutate(flag.id)} />
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
			<MutationStatus isPending={remove.isPending} error={remove.error} />
		</Panel>
	);
}
