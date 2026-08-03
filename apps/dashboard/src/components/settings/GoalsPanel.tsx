// Goals panel: create (name / type event|path / match value), list, and delete conversion goals.

import { type FormEvent, type ReactElement, useState } from 'react';
import { useAdminGoals, useCreateGoal, useDeleteGoal } from '../../hooks/admin.js';
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

export function GoalsPanel({
	token,
	siteId,
}: {
	token: string;
	siteId: string;
}): ReactElement {
	const goals = useAdminGoals(token, siteId);
	const create = useCreateGoal(token, siteId);
	const remove = useDeleteGoal(token, siteId);

	const [name, setName] = useState('');
	const [type, setType] = useState<'event' | 'path'>('event');
	const [matchValue, setMatchValue] = useState('');

	const canSubmit = Boolean(name.trim() && matchValue.trim());
	const blocked = canSubmit
		? null
		: !name.trim() && !matchValue.trim()
			? 'Enter a name and the value to match.'
			: !name.trim()
				? 'Enter a name for this goal.'
				: `Enter the ${type} to match.`;

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		create.mutate(
			{
				site_id: siteId,
				name: name.trim(),
				type,
				match_value: matchValue.trim(),
			},
			{
				onSuccess: () => {
					setName('');
					setMatchValue('');
				},
			},
		);
	}

	return (
		<Panel
			title="Goals"
			description="A goal counts a conversion whenever an event name or a page path matches exactly."
		>
			<form onSubmit={onSubmit}>
				<FormControls
					busy={create.isPending}
					className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr_auto]"
				>
					<Field
						id="goal-name"
						label="Name"
						value={name}
						onChange={setName}
						placeholder="Signup"
					/>
					<Select
						id="goal-type"
						label="Type"
						value={type}
						onChange={(next) => setType(next as 'event' | 'path')}
					>
						<option value="event">event</option>
						<option value="path">path</option>
					</Select>
					<Field
						id="goal-match"
						label="Match value"
						value={matchValue}
						onChange={setMatchValue}
						placeholder={type === 'event' ? 'signup' : '/thank-you'}
					/>
					<div className="flex items-start pt-5">
						<button
							type="submit"
							disabled={!canSubmit}
							className="btn-accent w-full rounded-lg px-4 py-1.5 text-sm transition sm:w-auto"
						>
							Add goal
						</button>
					</div>
				</FormControls>
			</form>
			<div className="mt-2">
				<BlockedReason reason={blocked} />
			</div>
			<MutationStatus
				isPending={create.isPending}
				error={create.error}
				success={create.isSuccess ? 'Goal created.' : null}
				pendingLabel="Creating goal…"
			/>

			<div className="mt-5">
				{goals.isLoading ? (
					<CardSkeletons count={2} />
				) : goals.error ? (
					<ErrorState
						message="Could not load goals"
						detail={goals.error instanceof Error ? goals.error.message : null}
					/>
				) : goals.data && goals.data.goals.length > 0 ? (
					<ul className="divide-y divide-[color:rgb(var(--border))]">
						{goals.data.goals.map((g) => (
							<li
								key={g.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-[color:var(--ink)]">
										{g.name}
									</p>
									<p className="truncate text-[color:var(--muted)] text-xs">
										{g.type}: {g.match_value}
									</p>
								</div>
								<ConfirmDelete
									onConfirm={() => remove.mutate(g.id)}
									consequence={`Delete "${g.name}" and its conversion history?`}
									busy={remove.isPending}
								/>
							</li>
						))}
					</ul>
				) : (
					<EmptyState title="No goals yet">Add a goal to track conversions.</EmptyState>
				)}
			</div>
			<MutationStatus
				isPending={remove.isPending}
				error={remove.error}
				pendingLabel="Deleting goal…"
			/>
		</Panel>
	);
}
