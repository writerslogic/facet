// Goal conversions: one row per goal with its conversion count and rate over the active range.
// Empty state links to Settings ("Create a goal in Settings"); loading/error states are explicit.

import type { Goal } from '@facet/shared';
import type { ReactElement } from 'react';
import { useConversions } from '../hooks/funnels.js';
import type { Range } from '../state.js';
import { CardSkeletons, EmptyState, ErrorState } from './StatusStates.js';

const numberFormat = new Intl.NumberFormat('en-US');
const percentFormat = new Intl.NumberFormat('en-US', {
	style: 'percent',
	maximumFractionDigits: 1,
});

function GoalRow({
	apiKey,
	siteId,
	goal,
	range,
}: {
	apiKey: string;
	siteId: string;
	goal: Goal;
	range: Range;
}): ReactElement {
	const { data } = useConversions(apiKey, siteId, goal.id, range);
	return (
		<li className="flex items-center justify-between py-2 text-sm">
			<span className="truncate text-neutral-800">
				{goal.name}
				<span className="ml-2 text-xs text-neutral-400">
					{goal.type}: {goal.match_value}
				</span>
			</span>
			<span className="pl-3 text-neutral-600 tabular-nums">
				{data ? numberFormat.format(data.conversions) : '—'}
				<span className="ml-2 font-medium text-neutral-900">
					{data ? percentFormat.format(data.rate) : ''}
				</span>
			</span>
		</li>
	);
}

export function Conversions({
	apiKey,
	siteId,
	goals,
	range,
	loading,
	error,
	onOpenSettings,
}: {
	apiKey: string;
	siteId: string;
	goals: Goal[];
	range: Range;
	loading?: boolean;
	error?: unknown;
	onOpenSettings: () => void;
}): ReactElement {
	return (
		<section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
			<h3 className="mb-3 text-sm font-medium text-neutral-500">Goal Conversions</h3>
			{loading ? (
				<CardSkeletons count={2} />
			) : error ? (
				<ErrorState
					message="Could not load goals"
					detail={error instanceof Error ? error.message : null}
				/>
			) : goals.length === 0 ? (
				<EmptyState title="No goals yet">
					<button
						type="button"
						onClick={onOpenSettings}
						className="font-medium text-accent-600 underline hover:text-accent-800"
					>
						Create a goal in Settings
					</button>
				</EmptyState>
			) : (
				<ul className="divide-y divide-neutral-100">
					{goals.map((goal) => (
						<GoalRow
							key={goal.id}
							apiKey={apiKey}
							siteId={siteId}
							goal={goal}
							range={range}
						/>
					))}
				</ul>
			)}
		</section>
	);
}
