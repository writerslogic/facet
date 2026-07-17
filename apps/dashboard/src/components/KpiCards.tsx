// Top KPI cards: pageviews, unique visitors, custom events — with optional period-over-period deltas
// and a tiny sparkline drawn from the primary series.

import type { SeriesPoint, StatsSummary } from '@facet/shared';
import type { ReactElement } from 'react';
import { computeDelta, formatNumber } from '../lib/format.js';
import { KpiCard } from './KpiCard.js';

export function KpiCards({
	summary,
	compare,
	series,
}: {
	summary: StatsSummary;
	compare?: StatsSummary | null;
	series?: SeriesPoint[];
}): ReactElement {
	const pv = series?.map((p) => p.pageviews) ?? [];
	const vis = series?.map((p) => p.visitors) ?? [];

	const cards = [
		{
			label: 'Pageviews',
			value: summary.pageviews,
			prev: compare?.pageviews,
			spark: pv,
			stroke: '#0f172a',
		},
		{
			label: 'Unique Visitors',
			value: summary.visitors,
			prev: compare?.visitors,
			spark: vis,
			stroke: '#6366f1',
		},
		{
			label: 'Custom Events',
			value: summary.events,
			prev: compare?.events,
		},
	];

	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
			{cards.map((card) => (
				<KpiCard
					key={card.label}
					label={card.label}
					value={formatNumber(card.value)}
					delta={card.prev != null ? computeDelta(card.value, card.prev, 'up') : null}
					sparkline={card.spark}
					sparklineStroke={card.stroke}
				/>
			))}
		</div>
	);
}
