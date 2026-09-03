// Funnels panel: create a funnel with 2–10 ordered steps (type + match value), list, and delete.

import type { Funnel, FunnelStep } from '@facet/shared';
import { ChevronDown, ChevronUp, Pencil, Plus, X } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import {
	useAdminFunnels,
	useCreateFunnel,
	useDeleteFunnel,
	useUpdateFunnel,
} from '../../hooks/admin.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import { BlockedReason, ConfirmDelete, Field, FormControls, MutationStatus, Panel } from './kit.js';

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
	const update = useUpdateFunnel(token, siteId);
	const remove = useDeleteFunnel(token, siteId);

	const [editingId, setEditingId] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [steps, setSteps] = useState<FunnelStep[]>([emptyStep(), emptyStep()]);

	const filledSteps = steps.filter((s) => s.match_value.trim());
	const allStepsFilled = filledSteps.length === steps.length;
	const canSubmit = Boolean(
		name.trim() && allStepsFilled && filledSteps.length >= 2 && filledSteps.length <= 10,
	);
	const blocked = canSubmit
		? null
		: !name.trim()
			? 'Enter a name for this funnel.'
			: `Fill every ordered step — ${filledSteps.length} of ${steps.length} have a match value.`;
	const busy = create.isPending || update.isPending;

	function resetEditor(): void {
		setEditingId(null);
		setName('');
		setSteps([emptyStep(), emptyStep()]);
	}

	function startEditing(funnel: Funnel): void {
		setEditingId(funnel.id);
		setName(funnel.name);
		setSteps(funnel.steps.map((step) => ({ ...step })));
	}

	function updateStep(index: number, patch: Partial<FunnelStep>): void {
		setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
	}

	function moveStep(index: number, offset: -1 | 1): void {
		setSteps((previous) => {
			const destination = index + offset;
			if (destination < 0 || destination >= previous.length) return previous;
			const next = [...previous];
			const current = next[index];
			const target = next[destination];
			if (!current || !target) return previous;
			next[index] = target;
			next[destination] = current;
			return next;
		});
	}

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		const body = {
			site_id: siteId,
			name: name.trim(),
			steps: filledSteps.map((step) => ({
				type: step.type,
				match_value: step.match_value.trim(),
			})),
		};
		if (editingId) {
			update.mutate({ id: editingId, body }, { onSuccess: resetEditor });
		} else {
			create.mutate(body, { onSuccess: resetEditor });
		}
	}

	return (
		<Panel
			title="Funnels"
			description="An ordered path through your site. Drop-off is measured between consecutive steps; every step must be complete."
		>
			<div className="mb-3 flex items-center justify-between gap-3">
				<p className="font-medium text-sm text-[color:var(--ink)]">
					{editingId ? 'Edit funnel' : 'Create funnel'}
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
					<Field
						id="funnel-name"
						label="Name"
						value={name}
						onChange={setName}
						placeholder="Checkout"
					/>

					<fieldset className="space-y-2">
						<legend className="font-medium text-[color:var(--muted)] text-xs">
							Steps (2–10)
						</legend>
						{steps.map((step, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: steps are positional and reorder as a unit
							<div key={index} className="flex items-center gap-2">
								<span
									data-chrome
									className="w-5 text-[color:var(--muted)] text-xs tabular-nums"
								>
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
									className="input rounded-lg px-2 py-1.5 text-sm"
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
									className="input min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm"
								/>
								<div className="flex shrink-0 items-center">
									<button
										type="button"
										disabled={index === 0}
										onClick={() => moveStep(index, -1)}
										aria-label={`Move step ${index + 1} up`}
										className="rounded-md p-1 text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] disabled:opacity-30"
									>
										<ChevronUp className="h-4 w-4" aria-hidden="true" />
									</button>
									<button
										type="button"
										disabled={index === steps.length - 1}
										onClick={() => moveStep(index, 1)}
										aria-label={`Move step ${index + 1} down`}
										className="rounded-md p-1 text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] disabled:opacity-30"
									>
										<ChevronDown className="h-4 w-4" aria-hidden="true" />
									</button>
								</div>
								{steps.length > 2 ? (
									<button
										type="button"
										onClick={() =>
											setSteps((prev) => prev.filter((_, i) => i !== index))
										}
										aria-label={`Remove step ${index + 1}`}
										className="rounded-md p-1 text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
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
								className="inline-flex items-center gap-1 font-medium text-[color:var(--chip-ink)] text-xs"
							>
								<Plus className="h-3.5 w-3.5" aria-hidden="true" />
								Add step
							</button>
						) : null}
					</fieldset>

					<div className="space-y-1">
						<button
							type="submit"
							disabled={!canSubmit}
							className="btn-accent rounded-lg px-4 py-1.5 text-sm transition"
						>
							{editingId ? 'Save funnel' : 'Create funnel'}
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
						? 'Funnel created.'
						: update.isSuccess
							? 'Funnel updated.'
							: null
				}
				pendingLabel={editingId ? 'Saving funnel…' : 'Creating funnel…'}
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
					<ul className="divide-y divide-[color:rgb(var(--border))]">
						{funnels.data.funnels.map((f) => (
							<li
								key={f.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-[color:var(--ink)]">
										{f.name}
									</p>
									<p className="truncate text-[color:var(--muted)] text-xs">
										{f.steps.length} steps
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									<button
										type="button"
										onClick={() => startEditing(f)}
										aria-label={`Edit ${f.name}`}
										className="btn-ghost rounded-lg p-1.5"
									>
										<Pencil className="h-4 w-4" aria-hidden="true" />
									</button>
									<ConfirmDelete
										onConfirm={() => remove.mutate(f.id)}
										consequence={`Delete "${f.name}"? Its drop-off report goes with it.`}
										busy={remove.isPending}
									/>
								</div>
							</li>
						))}
					</ul>
				) : (
					<EmptyState title="No funnels yet">
						Create a funnel to measure step drop-off.
					</EmptyState>
				)}
			</div>
			<MutationStatus
				isPending={remove.isPending}
				error={remove.error}
				pendingLabel="Deleting funnel…"
			/>
		</Panel>
	);
}
