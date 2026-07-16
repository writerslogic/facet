// KPI summary cards: pageviews, unique visitors, custom events, formatted with Intl.

import type { StatsSummary } from '@countless/shared';
import type { ReactElement } from 'react';

const numberFormat = new Intl.NumberFormat('en-US');

interface Kpi {
	label: string;
	value: number;
}

export function KpiCards({ summary }: { summary: StatsSummary }): ReactElement {
	const cards: Kpi[] = [
		{ label: 'Pageviews', value: summary.pageviews },
		{ label: 'Unique Visitors', value: summary.visitors },
		{ label: 'Custom Events', value: summary.events },
	];

	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
			{cards.map((card) => (
				<div
					key={card.label}
					className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm"
				>
					<div className="text-sm font-medium text-neutral-500">{card.label}</div>
					<div className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900 tabular-nums">
						{numberFormat.format(card.value)}
					</div>
				</div>
			))}
		</div>
	);
}
