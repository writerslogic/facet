// Engagement box: sessions, bounce rate, pages/session, avg duration. Compact = a stat list; expanded =
// a stat-card grid + a bounce-rate bar.
//
// This box has no rows, so it has nothing to drill INTO — engagement is session-derived and lives
// outside the cube, and there is no per-device or per-country engagement on the client to compose it
// from. What a static readout was actually missing is the other axis: is 62% bounce better or worse
// than it was? So every figure now carries its movement against the equal-length preceding window,
// read from the comparison the Overview already fetched — no query of its own, and nothing at all
// while a segment is active (that window is not filtered to match, so a delta would be a lie).

import type { EngagementSummary } from '@facet/shared';
import type { ReactNode } from 'react';
import { usePreviousPeriodStats } from '../../hooks/compare.js';
import {
	type Movement,
	countMovement,
	formatDuration,
	formatNumber,
	formatPercent,
	rateMovement,
} from '../../lib/format.js';
import { DeltaBadge } from '../Delta.js';
import type { TileDef } from './types.js';

/** One engagement figure and how it moved. `movement` is null whenever there is nothing honest to say. */
interface EngagementCell {
	label: string;
	value: string;
	movement: Movement | null;
}

/**
 * The four figures with their movements. Direction is per metric and it is NOT all "up is good": a
 * rising bounce rate is a regression, everything else here reads as engagement. Bounce is a fraction,
 * so it moves in percentage POINTS (60% → 66% is +6 pts, not +10%); the rest are counts and move as
 * percentages. Pages/session is scaled to hundredths first so `countMovement`'s low-volume guard sees
 * a real base rather than the number 2.
 */
function cells(e: EngagementSummary, previous: EngagementSummary | null): EngagementCell[] {
	return [
		{
			label: 'Sessions',
			value: formatNumber(e.sessions),
			movement: countMovement(e.sessions, previous?.sessions),
		},
		{
			label: 'Bounce rate',
			value: formatPercent(e.bounce_rate),
			movement: rateMovement(e.bounce_rate, previous?.bounce_rate ?? null, 'down'),
		},
		{
			label: 'Pages / session',
			value: e.pages_per_session.toFixed(1),
			movement: countMovement(
				Math.round(e.pages_per_session * 100),
				previous ? Math.round(previous.pages_per_session * 100) : null,
			),
		},
		{
			label: 'Avg. duration',
			value: formatDuration(e.avg_duration_ms),
			movement: countMovement(e.avg_duration_ms, previous?.avg_duration_ms),
		},
	];
}

/** A tiny stat row for the compact engagement view. */
function Stat({ label, value, movement }: EngagementCell): ReactNode {
	return (
		<div className="flex items-baseline justify-between gap-2 border-[color:rgb(var(--border))] border-b py-2 last:border-0">
			<span className="text-[color:var(--muted)] text-xs">{label}</span>
			<span className="tabular flex items-baseline gap-1.5 font-semibold text-[color:var(--ink)] text-sm">
				{value}
				<DeltaBadge movement={movement} size="sm" />
			</span>
		</div>
	);
}

/** The engagement body. A component, not an inline render, because it owns the comparison hook. */
function EngagementBody({
	engagement,
	expanded,
}: {
	engagement: EngagementSummary;
	expanded: boolean;
}): ReactNode {
	const previous = usePreviousPeriodStats();
	const list = cells(engagement, previous?.engagement ?? null);
	if (expanded) {
		return (
			<div className="flex h-full flex-col gap-3">
				<div className="grid grid-cols-2 gap-3">
					{list.map((c) => (
						<div
							key={c.label}
							className="rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] p-3"
						>
							<div className="text-[10px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em]">
								{c.label}
							</div>
							<div className="tabular mt-1 flex items-baseline gap-2 font-semibold text-2xl text-[color:var(--ink)]">
								{c.value}
								<DeltaBadge movement={c.movement} size="sm" />
							</div>
						</div>
					))}
				</div>
				<div className="mt-auto">
					<div className="mb-1 flex justify-between text-[11px] text-[color:var(--muted)]">
						<span>Bounce rate</span>
						<span className="tabular">{formatPercent(engagement.bounce_rate)}</span>
					</div>
					<div className="h-2 w-full overflow-hidden rounded-full bg-[color:rgb(var(--hover))]">
						<div
							className="h-full rounded-full bg-[var(--d1)] transition-[width] duration-500 ease-out"
							style={{
								width: `${Math.min(100, Math.round(engagement.bounce_rate * 100))}%`,
							}}
						/>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="flex h-full flex-col justify-center">
			{list.map((c) => (
				<Stat key={c.label} {...c} />
			))}
		</div>
	);
}

export const engagementBox: TileDef = {
	id: 'engagement',
	title: 'Engagement',
	size: 'md',
	expandable: true,
	table: (ctx) => {
		const e = ctx.engagement;
		return {
			columns: ['Metric', 'Value'],
			rows: [
				['Sessions', e.sessions],
				['Bounce rate', `${Math.round(e.bounce_rate * 100)}%`],
				['Pages / session', e.pages_per_session.toFixed(1)],
				['Avg. duration (ms)', e.avg_duration_ms],
			],
		};
	},
	render: (ctx, expanded) => (
		<EngagementBody engagement={ctx.engagement} expanded={Boolean(expanded)} />
	),
};
