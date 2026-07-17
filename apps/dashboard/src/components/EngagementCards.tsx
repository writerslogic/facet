// Engagement KPI cards: sessions, bounce rate, pages/session, avg duration (m:ss).

import type { EngagementSummary } from '@facet/shared';
import type { ReactElement } from 'react';

const numberFormat = new Intl.NumberFormat('en-US');
const decimalFormat = new Intl.NumberFormat('en-US', {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});

function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function EngagementCards({
	engagement,
}: {
	engagement: EngagementSummary;
}): ReactElement {
	const cards = [
		{ label: 'Sessions', value: numberFormat.format(engagement.sessions) },
		{
			label: 'Bounce Rate',
			value: `${Math.round(engagement.bounce_rate * 100)}%`,
		},
		{
			label: 'Pages / Session',
			value: decimalFormat.format(engagement.pages_per_session),
		},
		{
			label: 'Avg Duration',
			value: formatDuration(engagement.avg_duration_ms),
		},
	];

	return (
		<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
			{cards.map((card) => (
				<div
					key={card.label}
					className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm"
				>
					<div className="text-sm font-medium text-neutral-500">{card.label}</div>
					<div className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900 tabular-nums">
						{card.value}
					</div>
				</div>
			))}
		</div>
	);
}
