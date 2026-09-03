// Engagement box: sessions, bounce rate, pages/session, avg duration. Compact = the bounce-rate
// leader row; default = a stat list; expanded = a stat-card grid + a bounce-rate bar.
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
	exactHint,
	formatDecimal,
	formatDuration,
	formatKpi,
	formatNumber,
	formatPercent,
	rateMovement,
} from '../../lib/format.js';
import { DeltaBadge } from '../Delta.js';
import { ChartEmpty } from '../charts/ChartChrome.js';
import type { TileDef, TileDensity } from './types.js';

/** One engagement figure and how it moved. `movement` is null whenever there is nothing honest to say. */
interface EngagementCell {
	label: string;
	value: string;
	movement: Movement | null;
}

/**
 * Bounce, in one place because two tiers read it: a rising bounce rate is a REGRESSION, which is the
 * one direction here that is not "up is good", and it is a fraction, so it moves in percentage POINTS
 * (60% → 66% is +6 pts, not +10%).
 */
function bounceCell(e: EngagementSummary, previous: EngagementSummary | null): EngagementCell {
	return {
		label: 'Bounce rate',
		value: formatPercent(e.bounce_rate),
		movement: rateMovement(e.bounce_rate, previous?.bounce_rate ?? null, 'down'),
	};
}

/**
 * The four figures with their movements. Everything but bounce reads as engagement and is a count, so
 * it moves as a percentage. Pages/session is scaled to hundredths first so `countMovement`'s
 * low-volume guard sees a real base rather than the number 2.
 */
function cells(e: EngagementSummary, previous: EngagementSummary | null): EngagementCell[] {
	return [
		{
			label: 'Sessions',
			value: formatNumber(e.sessions),
			movement: countMovement(e.sessions, previous?.sessions),
		},
		bounceCell(e, previous),
		{
			label: 'Pages / session',
			value: formatDecimal(e.pages_per_session),
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

/** How full the bounce bar draws, capped so a rate above 1 cannot overflow its track. */
function barPercent(rate: number): number {
	return Math.min(100, Math.round(rate * 100));
}

/**
 * The `compact` rendering. Four stat rows need ~132px and a squeezed tile has ~50, so the stat list
 * degrades to four clipped slivers rather than four figures. Answer the one question this box exists
 * to answer instead: of the four, bounce is the only one with a direction (down is good) and the only
 * one no other tile carries — sessions, and the volume story, are already the KPI band's job. So the
 * rate leads with its own share bar, and the other three trail as one line of context.
 */
function EngagementLead({
	engagement,
	previous,
}: {
	engagement: EngagementSummary;
	previous: EngagementSummary | null;
}): ReactNode {
	if (engagement.sessions === 0) return <ChartEmpty reason="range" compact />;
	const bounce = bounceCell(engagement, previous);
	const exact = exactHint(engagement.sessions);
	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* my-auto, not justify-center: an auto margin collapses to zero when the box is shorter
			    than its content, so the leader row can never be centred off the top of the scroller. */}
			<div className="my-auto flex flex-col gap-1">
				<div className="relative flex items-center gap-2 overflow-hidden rounded-md px-2 py-1.5">
					<span
						aria-hidden="true"
						className="absolute inset-y-0 left-0 rounded-md opacity-25"
						style={{
							width: `${barPercent(engagement.bounce_rate)}%`,
							background: 'var(--d1)',
						}}
					/>
					<span className="relative min-w-0 truncate font-medium text-[color:var(--ink)] text-xs">
						{bounce.label}
					</span>
					<span className="relative ml-auto shrink-0 font-semibold text-[color:var(--ink)] text-sm tabular-nums">
						{bounce.value}
					</span>
					<DeltaBadge
						movement={bounce.movement}
						size="sm"
						className="relative shrink-0"
					/>
				</div>
				<p className="truncate px-2 text-[10px] text-[color:var(--faint)] tabular-nums">
					<span title={exact ?? undefined}>{formatKpi(engagement.sessions)}</span>{' '}
					sessions · {formatDecimal(engagement.pages_per_session)} pages ·{' '}
					{formatDuration(engagement.avg_duration_ms)} avg
				</p>
			</div>
		</div>
	);
}

/** A tiny stat row for the default engagement view. */
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
	density,
}: {
	engagement: EngagementSummary;
	density: TileDensity;
}): ReactNode {
	const compared = usePreviousPeriodStats()?.engagement ?? null;
	// IMPORTANT: a preceding window with no sessions has no rates to compare against. `rateMovement`
	// has no zero-base guard, so the server's `bounce_rate: 0` would read as a measured regression.
	const previous = compared && compared.sessions > 0 ? compared : null;
	if (density === 'compact') {
		return <EngagementLead engagement={engagement} previous={previous} />;
	}
	const list = cells(engagement, previous);
	if (density === 'expanded') {
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
					<div
						aria-hidden="true"
						className="h-2 w-full overflow-hidden rounded-full bg-[color:rgb(var(--hover))]"
					>
						<div
							className="h-full rounded-full bg-[var(--d1)] transition-[width] duration-500 ease-out"
							style={{ width: `${barPercent(engagement.bounce_rate)}%` }}
						/>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* my-auto for the same reason the compact tier uses it: 133–190px is still `default`, and
			    four stat rows do not fit that, so centring would scroll the first row out of reach. */}
			<div className="my-auto">
				{list.map((c) => (
					<Stat key={c.label} {...c} />
				))}
			</div>
		</div>
	);
}

export const engagementBox: TileDef = {
	// Machine-readable values, not the tile's own strings: this grid is copied as TSV into a
	// spreadsheet, where "62%" is text and a locale-grouped count is a broken cell.
	table: (ctx) => {
		const e = ctx.engagement;
		return {
			columns: ['Metric', 'Value'],
			rows: [
				['Sessions', e.sessions],
				['Bounce rate %', Number((e.bounce_rate * 100).toFixed(1))],
				['Pages / session', Number(e.pages_per_session.toFixed(1))],
				['Avg. duration (ms)', e.avg_duration_ms],
			],
		};
	},
	render: (ctx, density) => <EngagementBody engagement={ctx.engagement} density={density} />,
};
