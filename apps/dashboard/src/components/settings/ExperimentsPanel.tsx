// Experiments panel: create an experiment (name, flag key, 2–8 variants with weights), list, delete.

import type { ExperimentVariant } from '@facet/shared';
import { Plus, X } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import {
	useAdminExperiments,
	useCreateExperiment,
	useDeleteExperiment,
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
	const remove = useDeleteExperiment(token, siteId);

	const [name, setName] = useState('');
	const [flagKey, setFlagKey] = useState('');
	const [variants, setVariants] = useState<ExperimentVariant[]>([
		{ key: 'control', weight: 1 },
		{ key: '', weight: 1 },
	]);

	const filledVariants = variants.filter((v) => v.key.trim());
	const canSubmit = Boolean(
		name.trim() && flagKey.trim() && filledVariants.length >= 2 && filledVariants.length <= 8,
	);
	const blocked = canSubmit
		? null
		: !name.trim()
			? 'Enter a name for this experiment.'
			: !flagKey.trim()
				? 'Enter the flag key this experiment drives.'
				: `Name at least 2 variants — ${filledVariants.length} of ${variants.length} have a key.`;

	function updateVariant(index: number, patch: Partial<ExperimentVariant>): void {
		setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
	}

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		create.mutate(
			{
				site_id: siteId,
				name: name.trim(),
				flag_key: flagKey.trim(),
				variants: filledVariants.map((v) => ({
					key: v.key.trim(),
					weight: Number.isFinite(v.weight) ? v.weight : 0,
				})),
			},
			{
				onSuccess: () => {
					setName('');
					setFlagKey('');
					setVariants([
						{ key: 'control', weight: 1 },
						{ key: '', weight: 1 },
					]);
				},
			},
		);
	}

	return (
		<Panel
			title="Experiments"
			description="Assigns visitors to variants of a flag and reports the result. Weights are relative, not percentages."
		>
			<form onSubmit={onSubmit}>
				<FormControls busy={create.isPending} className="space-y-3">
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

					<div className="space-y-1">
						<button
							type="submit"
							disabled={!canSubmit}
							className="btn-accent rounded-lg px-4 py-1.5 text-sm transition"
						>
							Create experiment
						</button>
						<BlockedReason reason={blocked} />
					</div>
				</FormControls>
			</form>
			<MutationStatus
				isPending={create.isPending}
				error={create.error}
				success={create.isSuccess ? 'Experiment created.' : null}
				pendingLabel="Creating experiment…"
			/>

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
										flag: {exp.flag_key} · {exp.variants.length} variants
									</p>
								</div>
								<ConfirmDelete
									onConfirm={() => remove.mutate(exp.id)}
									consequence={`Delete "${exp.name}"? Its results are removed too.`}
									busy={remove.isPending}
								/>
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
