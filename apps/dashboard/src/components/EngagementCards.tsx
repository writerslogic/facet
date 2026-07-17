// Engagement KPI cards: sessions, bounce rate, pages/session, avg duration — with optional
// period-over-period deltas. Bounce rate improves when it falls; the others improve when they rise.

import type { EngagementSummary } from '@facet/shared';
import type { ReactElement } from 'react';
import { type MetricDirection, computeDelta, formatDuration, formatNumber } from '../lib/format.js';
import { KpiCard } from './KpiCard.js';

const decimalFormat = new Intl.NumberFormat('en-US', {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});

export function EngagementCards({
	engagement,
	compare,
}: {
	engagement: EngagementSummary;
	compare?: EngagementSummary | null;
}): ReactElement {
	const cards: {
		label: string;
		value: string;
		metric: number;
		prev: number | undefined;
		direction: MetricDirection;
	}[] = [
		{
			label: 'Sessions',
			value: formatNumber(engagement.sessions),
			metric: engagement.sessions,
			prev: compare?.sessions,
			direction: 'up',
		},
		{
			label: 'Bounce Rate',
			value: `${Math.round(engagement.bounce_rate * 100)}%`,
			metric: engagement.bounce_rate,
			prev: compare?.bounce_rate,
			direction: 'down',
		},
		{
			label: 'Pages / Session',
			value: decimalFormat.format(engagement.pages_per_session),
			metric: engagement.pages_per_session,
			prev: compare?.pages_per_session,
			direction: 'up',
		},
		{
			label: 'Avg Duration',
			value: formatDuration(engagement.avg_duration_ms),
			metric: engagement.avg_duration_ms,
			prev: compare?.avg_duration_ms,
			direction: 'up',
		},
	];

	return (
		<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
			{cards.map((card) => (
				<KpiCard
					key={card.label}
					label={card.label}
					value={card.value}
					delta={
						card.prev != null
							? computeDelta(card.metric, card.prev, card.direction)
							: null
					}
				/>
			))}
		</div>
	);
}
