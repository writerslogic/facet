// Goal conversions: one row per goal with its conversion count and rate over the active range.

import type { Goal } from '@facet/shared';
import type { ReactElement } from 'react';
import { useConversions } from '../hooks/funnels.js';
import type { Range } from '../state.js';

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
}: {
	apiKey: string;
	siteId: string;
	goals: Goal[];
	range: Range;
}): ReactElement {
	return (
		<section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
			<h3 className="mb-3 text-sm font-medium text-neutral-500">Goal Conversions</h3>
			{goals.length === 0 ? (
				<p className="py-6 text-center text-sm text-neutral-400">
					No goals defined. Create one with the admin API.
				</p>
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
