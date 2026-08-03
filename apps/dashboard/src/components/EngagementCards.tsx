// Engagement KPI cards: sessions, bounce rate, pages/session, avg duration — with optional
// period-over-period deltas. Bounce rate improves when it falls; the others improve when they rise.

import type { EngagementSummary } from '@facet/shared';
import type { ReactElement } from 'react';
import {
	type MetricDirection,
	computeDelta,
	exactHint,
	formatDecimal,
	formatDuration,
	formatKpi,
} from '../lib/format.js';
import { KpiCard } from './KpiCard.js';

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
		hint?: string;
	}[] = [
		{
			label: 'Sessions',
			// The only unbounded figure in this row of four, and the row shrinks to its widest member —
			// so past six digits it abbreviates, with the exact count kept on the tile's tooltip. The
			// other three are a percentage, a small decimal and a duration: all naturally short, and
			// all values somebody quotes, so they stay exact.
			value: formatKpi(engagement.sessions),
			hint: exactHint(engagement.sessions)
				? `${exactHint(engagement.sessions)} sessions`
				: undefined,
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
			value: formatDecimal(engagement.pages_per_session),
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
					hint={card.hint}
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
