// Goals panel: create (name / type event|path / match value), list, and delete conversion goals.

import { type FormEvent, type ReactElement, useState } from 'react';
import { useAdminGoals, useCreateGoal, useDeleteGoal } from '../../hooks/admin.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import { ConfirmDelete, Field, MutationStatus, Panel } from './kit.js';

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

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!name.trim() || !matchValue.trim()) return;
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
		<Panel title="Goals">
			<form
				onSubmit={onSubmit}
				className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr_auto]"
			>
				<Field
					id="goal-name"
					label="Name"
					value={name}
					onChange={setName}
					placeholder="Signup"
				/>
				<div>
					<label
						htmlFor="goal-type"
						className="block text-xs font-medium text-neutral-600"
					>
						Type
					</label>
					<select
						id="goal-type"
						value={type}
						onChange={(e) => setType(e.target.value as 'event' | 'path')}
						className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
					>
						<option value="event">event</option>
						<option value="path">path</option>
					</select>
				</div>
				<Field
					id="goal-match"
					label="Match value"
					value={matchValue}
					onChange={setMatchValue}
					placeholder={type === 'event' ? 'signup' : '/thank-you'}
				/>
				<div className="flex items-end">
					<button
						type="submit"
						disabled={create.isPending || !name.trim() || !matchValue.trim()}
						className="w-full rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 sm:w-auto"
					>
						Add goal
					</button>
				</div>
			</form>
			<MutationStatus
				isPending={create.isPending}
				error={create.error}
				success={create.isSuccess ? 'Goal created.' : null}
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
					<ul className="divide-y divide-neutral-100">
						{goals.data.goals.map((g) => (
							<li
								key={g.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-neutral-800">
										{g.name}
									</p>
									<p className="truncate text-xs text-neutral-400">
										{g.type}: {g.match_value}
									</p>
								</div>
								<ConfirmDelete onConfirm={() => remove.mutate(g.id)} />
							</li>
						))}
					</ul>
				) : (
					<EmptyState title="No goals yet">Add a goal to track conversions.</EmptyState>
				)}
			</div>
			<MutationStatus isPending={remove.isPending} error={remove.error} />
		</Panel>
	);
}
