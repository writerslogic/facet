// Experiments panel: create an experiment (name, flag key, 2–8 variants with weights), list, delete.

import type {
	Experiment,
	ExperimentInput,
	ExperimentStatus,
	ExperimentVariant,
} from '@facet/shared';
import { Pencil, Play, Plus, Square, X } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import {
	useAdminExperiments,
	useCreateExperiment,
	useDeleteExperiment,
	useUpdateExperiment,
} from '../../hooks/admin.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import { BlockedReason, ConfirmDelete, Field, FormControls, MutationStatus, Panel } from './kit.js';

const emptyVariant = (): ExperimentVariant => ({ key: '', weight: 1 });

export function ExperimentsPanel({
	token,
	siteId,
}: {
	token: string;
	siteId: string;
}): ReactElement {
	const experiments = useAdminExperiments(token, siteId);
	const create = useCreateExperiment(token, siteId);
	const update = useUpdateExperiment(token, siteId);
	const remove = useDeleteExperiment(token, siteId);

	const [editingId, setEditingId] = useState<string | null>(null);
	const [startImmediately, setStartImmediately] = useState(false);
	const [name, setName] = useState('');
	const [flagKey, setFlagKey] = useState('');
	const [variants, setVariants] = useState<ExperimentVariant[]>([
		{ key: 'control', weight: 1 },
		{ key: '', weight: 1 },
	]);

	const filledVariants = variants.filter((variant) => variant.key.trim());
	const allVariantsFilled = filledVariants.length === variants.length;
	const keys = filledVariants.map((variant) => variant.key.trim());
	const uniqueKeys = new Set(keys).size === keys.length;
	const validWeights = filledVariants.every(
		(variant) => Number.isFinite(variant.weight) && variant.weight >= 0,
	);
	const totalWeight = filledVariants.reduce((total, variant) => total + variant.weight, 0);
	const canSubmit = Boolean(
		name.trim() &&
			flagKey.trim() &&
			allVariantsFilled &&
			filledVariants.length >= 2 &&
			filledVariants.length <= 8 &&
			uniqueKeys &&
			validWeights &&
			totalWeight > 0,
	);
	const blocked = canSubmit
		? null
		: !name.trim()
			? 'Enter a name for this experiment.'
			: !flagKey.trim()
				? 'Enter the flag key this experiment drives.'
				: !allVariantsFilled || filledVariants.length < 2
					? `Name every variant — ${filledVariants.length} of ${variants.length} have a key.`
					: !uniqueKeys
						? 'Variant keys must be unique.'
						: !validWeights
							? 'Every weight must be zero or greater.'
							: 'At least one variant must have a positive weight.';
	const busy = create.isPending || update.isPending;

	function resetEditor(): void {
		setEditingId(null);
		setStartImmediately(false);
		setName('');
		setFlagKey('');
		setVariants([
			{ key: 'control', weight: 1 },
			{ key: '', weight: 1 },
		]);
	}

	function startEditing(experiment: Experiment): void {
		if (experiment.status !== 'draft') return;
		setEditingId(experiment.id);
		setStartImmediately(false);
		setName(experiment.name);
		setFlagKey(experiment.flag_key);
		setVariants(experiment.variants.map((variant) => ({ ...variant })));
	}

	function body(status: ExperimentStatus): ExperimentInput {
		return {
			site_id: siteId,
			name: name.trim(),
			flag_key: flagKey.trim(),
			variants: filledVariants.map((variant) => ({
				key: variant.key.trim(),
				weight: variant.weight,
			})),
			status,
		};
	}

	function savedBody(experiment: Experiment, status: ExperimentStatus): ExperimentInput {
		return {
			site_id: siteId,
			name: experiment.name,
			flag_key: experiment.flag_key,
			variants: experiment.variants,
			status,
		};
	}

	function updateVariant(index: number, patch: Partial<ExperimentVariant>): void {
		setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
	}

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		if (editingId) {
			update.mutate({ id: editingId, body: body('draft') }, { onSuccess: resetEditor });
		} else {
			create.mutate(body(startImmediately ? 'active' : 'draft'), {
				onSuccess: resetEditor,
			});
		}
	}

	return (
		<Panel
			title="Experiments"
			description="Configure a draft, start its public allocation, then complete it to preserve a terminal result. Weights are relative, not percentages."
		>
			<div className="mb-3 flex items-center justify-between gap-3">
				<p className="font-medium text-sm text-[color:var(--ink)]">
					{editingId ? 'Edit draft' : 'Create experiment'}
				</p>
				{editingId ? (
					<button
						type="button"
						onClick={resetEditor}
						className="btn-ghost rounded-lg px-2.5 py-1 text-xs"
					>
						Cancel editing
					</button>
				) : null}
			</div>
			<form onSubmit={onSubmit}>
				<FormControls busy={busy} className="space-y-3">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field
							id="exp-name"
							label="Name"
							value={name}
							onChange={setName}
							placeholder="CTA color"
						/>
						<Field
							id="exp-flag"
							label="Flag key"
							value={flagKey}
							onChange={setFlagKey}
							placeholder="cta_color"
							hint="Matches the flag your app evaluates."
						/>
					</div>

					<fieldset className="space-y-2">
						<legend className="font-medium text-[color:var(--muted)] text-xs">
							Variants (2–8, first is control)
						</legend>
						{variants.map((variant, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: variants are positional
							<div key={index} className="flex items-center gap-2">
								<label className="sr-only" htmlFor={`exp-variant-key-${index}`}>
									Variant {index + 1} key
								</label>
								<input
									id={`exp-variant-key-${index}`}
									type="text"
									value={variant.key}
									onChange={(e) =>
										updateVariant(index, {
											key: e.target.value,
										})
									}
									placeholder={index === 0 ? 'control' : `variant ${index + 1}`}
									className="input min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm"
								/>
								<label className="sr-only" htmlFor={`exp-variant-weight-${index}`}>
									Variant {index + 1} weight
								</label>
								<input
									id={`exp-variant-weight-${index}`}
									type="number"
									min={0}
									step="any"
									value={variant.weight}
									onChange={(e) =>
										updateVariant(index, {
											weight: Number(e.target.value),
										})
									}
									className="input w-24 rounded-lg px-3 py-1.5 text-sm"
								/>
								<span className="w-12 text-right text-[color:var(--faint)] text-xs tabular-nums">
									{totalWeight > 0 && Number.isFinite(variant.weight)
										? `${((variant.weight / totalWeight) * 100).toFixed(0)}%`
										: '—'}
								</span>
								{variants.length > 2 ? (
									<button
										type="button"
										onClick={() =>
											setVariants((prev) =>
												prev.filter((_, i) => i !== index),
											)
										}
										aria-label={`Remove variant ${index + 1}`}
										className="rounded-md p-1 text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
									>
										<X className="h-4 w-4" aria-hidden="true" />
									</button>
								) : null}
							</div>
						))}
						{variants.length < 8 ? (
							<button
								type="button"
								onClick={() => setVariants((prev) => [...prev, emptyVariant()])}
								className="inline-flex items-center gap-1 font-medium text-[color:var(--chip-ink)] text-xs"
							>
								<Plus className="h-3.5 w-3.5" aria-hidden="true" />
								Add variant
							</button>
						) : null}
					</fieldset>

					{editingId ? null : (
						<label className="flex items-start gap-2 text-xs text-[color:var(--muted)]">
							<input
								type="checkbox"
								checked={startImmediately}
								onChange={(event) => setStartImmediately(event.target.checked)}
								className="mt-0.5"
							/>
							<span>
								Start immediately. Leave off to save an editable, non-public draft.
							</span>
						</label>
					)}

					<div className="space-y-1">
						<button
							type="submit"
							disabled={!canSubmit}
							className="btn-accent rounded-lg px-4 py-1.5 text-sm transition"
						>
							{editingId
								? 'Save draft'
								: startImmediately
									? 'Create and start'
									: 'Save draft'}
						</button>
						<BlockedReason reason={blocked} />
					</div>
				</FormControls>
			</form>
			<MutationStatus
				isPending={busy}
				error={create.error ?? update.error}
				success={
					create.isSuccess
						? 'Experiment created.'
						: update.isSuccess
							? 'Experiment updated.'
							: null
				}
				pendingLabel={editingId ? 'Saving draft…' : 'Creating experiment…'}
			/>
			<p className="alert-info mt-3 rounded-lg px-3 py-2 text-xs">
				Allocation is locked while an experiment is running. Starting or completing can take
				up to 60 seconds to clear the public config cache. Visitors with DNT, GPC, or an
				explicit Facet opt-out are not bucketed and do not emit exposure events.
			</p>

			<div className="mt-5">
				{experiments.isLoading ? (
					<CardSkeletons count={2} />
				) : experiments.error ? (
					<ErrorState
						message="Could not load experiments"
						detail={
							experiments.error instanceof Error ? experiments.error.message : null
						}
					/>
				) : experiments.data && experiments.data.experiments.length > 0 ? (
					<ul className="divide-y divide-[color:rgb(var(--border))]">
						{experiments.data.experiments.map((exp) => (
							<li
								key={exp.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-[color:var(--ink)]">
										{exp.name}
									</p>
									<p className="truncate text-[color:var(--muted)] text-xs">
										flag: {exp.flag_key} · {exp.variants.length} variants ·{' '}
										<span
											className={
												exp.status === 'active'
													? 'text-pos'
													: 'text-[color:var(--faint)]'
											}
										>
											{exp.status === 'active'
												? 'Active'
												: exp.status === 'completed'
													? 'Completed'
													: 'Draft'}
										</span>
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									{exp.status !== 'completed' ? (
										<button
											type="button"
											onClick={() =>
												update.mutate({
													id: exp.id,
													body: savedBody(
														exp,
														exp.status === 'active'
															? 'completed'
															: 'active',
													),
												})
											}
											aria-label={`${exp.status === 'active' ? 'Complete' : 'Start'} ${exp.name}`}
											className="btn-ghost inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs"
										>
											{exp.status === 'active' ? (
												<Square
													className="h-3.5 w-3.5"
													aria-hidden="true"
												/>
											) : (
												<Play className="h-3.5 w-3.5" aria-hidden="true" />
											)}
											{exp.status === 'active' ? 'Complete' : 'Start'}
										</button>
									) : null}
									<button
										type="button"
										disabled={exp.status !== 'draft'}
										onClick={() => startEditing(exp)}
										aria-label={`Edit ${exp.name}`}
										title={
											exp.status === 'draft'
												? 'Edit draft configuration'
												: 'Only draft experiments can be edited.'
										}
										className="btn-ghost rounded-lg p-1.5 disabled:opacity-30"
									>
										<Pencil className="h-4 w-4" aria-hidden="true" />
									</button>
									<ConfirmDelete
										onConfirm={() => remove.mutate(exp.id)}
										consequence={`Delete "${exp.name}"? Its results are removed too.`}
										busy={remove.isPending}
									/>
								</div>
							</li>
						))}
					</ul>
				) : (
					<EmptyState title="No experiments yet">
						Create an experiment to run an A/B test.
					</EmptyState>
				)}
			</div>
			<MutationStatus
				isPending={remove.isPending}
				error={remove.error}
				pendingLabel="Deleting experiment…"
			/>
		</Panel>
	);
}
