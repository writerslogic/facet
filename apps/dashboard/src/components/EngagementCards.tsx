// Engagement KPI cards: sessions, bounce rate, pages/session, avg duration — with optional
// period-over-period deltas. Bounce rate improves when it falls; the others improve when they rise.

import type { EngagementSummary } from '@facet/shared';
import type { ReactElement } from 'react';
import {
	computeDelta,
	exactHint,
	formatDecimal,
	formatDuration,
	formatKpi,
	rateMovement,
} from '../lib/format.js';
import { KpiCard, type KpiDelta } from './KpiCard.js';

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
		delta: KpiDelta | null;
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
			delta:
				compare?.sessions != null
					? computeDelta(engagement.sessions, compare.sessions, 'up')
					: null,
		},
		{
			label: 'Bounce Rate',
			value: `${Math.round(engagement.bounce_rate * 100)}%`,
			// Already a rate (0..1), so its movement is reported in percentage POINTS, not a relative
			// percent of a percent (computeDelta's shape) — a 0.32 → 0.40 rise is "+8.0 pts", not the
			// misleading "+25%" a plain relative-change calculation would produce.
			delta: rateMovement(engagement.bounce_rate, compare?.bounce_rate, 'down'),
		},
		{
			label: 'Pages / Session',
			value: formatDecimal(engagement.pages_per_session),
			delta:
				compare?.pages_per_session != null
					? computeDelta(engagement.pages_per_session, compare.pages_per_session, 'up')
					: null,
		},
		{
			label: 'Avg Duration',
			value: formatDuration(engagement.avg_duration_ms),
			delta:
				compare?.avg_duration_ms != null
					? computeDelta(engagement.avg_duration_ms, compare.avg_duration_ms, 'up')
					: null,
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
					delta={card.delta}
				/>
			))}
		</div>
	);
}
