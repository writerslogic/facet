// Funnels panel: create a funnel with 2–10 ordered steps (type + match value), list, and delete.

import type { FunnelStep } from '@facet/shared';
import { Plus, X } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useAdminFunnels, useCreateFunnel, useDeleteFunnel } from '../../hooks/admin.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import { ConfirmDelete, Field, MutationStatus, Panel } from './kit.js';

const emptyStep = (): FunnelStep => ({ type: 'path', match_value: '' });

export function FunnelsPanel({
	token,
	siteId,
}: {
	token: string;
	siteId: string;
}): ReactElement {
	const funnels = useAdminFunnels(token, siteId);
	const create = useCreateFunnel(token, siteId);
	const remove = useDeleteFunnel(token, siteId);

	const [name, setName] = useState('');
	const [steps, setSteps] = useState<FunnelStep[]>([emptyStep(), emptyStep()]);

	const filledSteps = steps.filter((s) => s.match_value.trim());
	const canSubmit = name.trim() && filledSteps.length >= 2 && filledSteps.length <= 10;

	function updateStep(index: number, patch: Partial<FunnelStep>): void {
		setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
	}

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		create.mutate(
			{
				site_id: siteId,
				name: name.trim(),
				steps: filledSteps.map((s) => ({
					type: s.type,
					match_value: s.match_value.trim(),
				})),
			},
			{
				onSuccess: () => {
					setName('');
					setSteps([emptyStep(), emptyStep()]);
				},
			},
		);
	}

	return (
		<Panel title="Funnels">
			<form onSubmit={onSubmit} className="space-y-3">
				<Field
					id="funnel-name"
					label="Name"
					value={name}
					onChange={setName}
					placeholder="Checkout"
				/>

				<fieldset className="space-y-2">
					<legend className="text-xs font-medium text-neutral-600">Steps (2–10)</legend>
					{steps.map((step, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: steps are positional and reorder as a unit
						<div key={index} className="flex items-center gap-2">
							<span className="w-5 text-xs text-neutral-400 tabular-nums">
								{index + 1}.
							</span>
							<label className="sr-only" htmlFor={`funnel-step-type-${index}`}>
								Step {index + 1} type
							</label>
							<select
								id={`funnel-step-type-${index}`}
								value={step.type}
								onChange={(e) =>
									updateStep(index, {
										type: e.target.value as FunnelStep['type'],
									})
								}
								className="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-neutral-900"
							>
								<option value="path">path</option>
								<option value="event">event</option>
							</select>
							<label className="sr-only" htmlFor={`funnel-step-value-${index}`}>
								Step {index + 1} match value
							</label>
							<input
								id={`funnel-step-value-${index}`}
								type="text"
								value={step.match_value}
								onChange={(e) =>
									updateStep(index, {
										match_value: e.target.value,
									})
								}
								placeholder={step.type === 'event' ? 'add_to_cart' : '/cart'}
								className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
							/>
							{steps.length > 2 ? (
								<button
									type="button"
									onClick={() =>
										setSteps((prev) => prev.filter((_, i) => i !== index))
									}
									aria-label={`Remove step ${index + 1}`}
									className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
								>
									<X className="h-4 w-4" aria-hidden="true" />
								</button>
							) : null}
						</div>
					))}
					{steps.length < 10 ? (
						<button
							type="button"
							onClick={() => setSteps((prev) => [...prev, emptyStep()])}
							className="inline-flex items-center gap-1 text-xs font-medium text-accent-600 hover:text-accent-800"
						>
							<Plus className="h-3.5 w-3.5" aria-hidden="true" />
							Add step
						</button>
					) : null}
				</fieldset>

				<button
					type="submit"
					disabled={create.isPending || !canSubmit}
					className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
				>
					Create funnel
				</button>
			</form>
			<MutationStatus
				isPending={create.isPending}
				error={create.error}
				success={create.isSuccess ? 'Funnel created.' : null}
			/>

			<div className="mt-5">
				{funnels.isLoading ? (
					<CardSkeletons count={2} />
				) : funnels.error ? (
					<ErrorState
						message="Could not load funnels"
						detail={funnels.error instanceof Error ? funnels.error.message : null}
					/>
				) : funnels.data && funnels.data.funnels.length > 0 ? (
					<ul className="divide-y divide-neutral-100">
						{funnels.data.funnels.map((f) => (
							<li
								key={f.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-neutral-800">
										{f.name}
									</p>
									<p className="truncate text-xs text-neutral-400">
										{f.steps.length} steps
									</p>
								</div>
								<ConfirmDelete onConfirm={() => remove.mutate(f.id)} />
							</li>
						))}
					</ul>
				) : (
					<EmptyState title="No funnels yet">
						Create a funnel to measure step drop-off.
					</EmptyState>
				)}
			</div>
			<MutationStatus isPending={remove.isPending} error={remove.error} />
		</Panel>
	);
}
