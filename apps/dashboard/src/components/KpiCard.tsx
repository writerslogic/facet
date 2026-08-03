// A single KPI card: label, big tabular value, an optional period-over-period delta, and an optional
// sparkline. The delta renders through the shared `DeltaBadge` (components/Delta.tsx) — this file
// used to own a private copy of those rules, which is how the funnel and the KPI cards ended up
// disagreeing about sign and wording.

import type { ReactElement, ReactNode } from 'react';
import { type Delta, toMovement } from '../lib/format.js';
import { DeltaBadge } from './Delta.js';
import { Sparkline } from './Sparkline.js';

export function KpiCard({
	label,
	value,
	delta,
	sparkline,
	sparklineStroke,
	hint,
}: {
	label: string;
	value: ReactNode;
	delta?: Delta | null;
	sparkline?: number[];
	sparklineStroke?: string;
	hint?: string;
}): ReactElement {
	return (
		<div className="surface flex flex-col justify-between rounded-2xl p-5 shadow-card transition-shadow hover:shadow-float">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div
						data-chrome
						className="font-medium text-[13px] text-[color:var(--muted)]"
						title={hint}
					>
						{label}
					</div>
					<div className="mt-1.5 font-semibold text-3xl text-[color:var(--ink)] tracking-tight tabular-nums">
						{value}
					</div>
				</div>
				{sparkline && sparkline.length > 1 ? (
					<Sparkline values={sparkline} stroke={sparklineStroke} />
				) : null}
			</div>
			{delta ? (
				<div className="mt-3">
					<DeltaBadge movement={toMovement(delta)} />
				</div>
			) : null}
		</div>
	);
}
