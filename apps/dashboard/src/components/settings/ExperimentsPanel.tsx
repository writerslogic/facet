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
import { ConfirmDelete, Field, MutationStatus, Panel } from './kit.js';

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
	const canSubmit =
		name.trim() && flagKey.trim() && filledVariants.length >= 2 && filledVariants.length <= 8;

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
		<Panel title="Experiments">
			<form onSubmit={onSubmit} className="space-y-3">
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
					/>
				</div>

				<fieldset className="space-y-2">
					<legend className="text-xs font-medium text-neutral-600">
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
								className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
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
								className="w-24 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
							/>
							{variants.length > 2 ? (
								<button
									type="button"
									onClick={() =>
										setVariants((prev) => prev.filter((_, i) => i !== index))
									}
									aria-label={`Remove variant ${index + 1}`}
									className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
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
							className="inline-flex items-center gap-1 text-xs font-medium text-sky-600 hover:text-sky-800"
						>
							<Plus className="h-3.5 w-3.5" aria-hidden="true" />
							Add variant
						</button>
					) : null}
				</fieldset>

				<button
					type="submit"
					disabled={create.isPending || !canSubmit}
					className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
				>
					Create experiment
				</button>
			</form>
			<MutationStatus
				isPending={create.isPending}
				error={create.error}
				success={create.isSuccess ? 'Experiment created.' : null}
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
					<ul className="divide-y divide-neutral-100">
						{experiments.data.experiments.map((exp) => (
							<li
								key={exp.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-neutral-800">
										{exp.name}
									</p>
									<p className="truncate text-xs text-neutral-400">
										flag: {exp.flag_key} · {exp.variants.length} variants
									</p>
								</div>
								<ConfirmDelete onConfirm={() => remove.mutate(exp.id)} />
							</li>
						))}
					</ul>
				) : (
					<EmptyState title="No experiments yet">
						Create an experiment to run an A/B test.
					</EmptyState>
				)}
			</div>
			<MutationStatus isPending={remove.isPending} error={remove.error} />
		</Panel>
	);
}
