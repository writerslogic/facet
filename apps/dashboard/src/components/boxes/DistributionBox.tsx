// Session distribution box: duration and pages-per-session as a box-and-whisker over a violin.
//
// TWO HONESTY OBLIGATIONS this box owns, neither of which belongs in the chart:
//
// 1. THE FILTER MISMATCH. `GET /api/stats/distribution` accepts only `channel`; `event_sessions` is
//    a materialized per-session row with no path, country, device or hostname column, and the route
//    400s rather than answering the unfiltered distribution under a filtered label. The board can
//    have any of those filters active. So the box forwards `channel` and, when any of the others is
//    on, says on screen that this tile is NOT sliced the way the rest of the board is. Passing them
//    would error; dropping them silently would be a lie with a filter chip sitting above it.
//
// 2. SUPPRESSION. Below 25 matching sessions the response carries no statistics at all, and the
//    chart renders the reason rather than an empty box (see `Distribution.tsx`).
//
// THE THREE TIERS. `default`/`expanded` draw the chart; `expanded` adds the visible statistic strip,
// because at rest the eleven statistics are reachable only by hovering a mark. `compact` cannot draw
// a 190px plot at all, so it answers the one question a distribution exists to answer — the typical
// session, and how wide the middle half spreads around it — as a median with a p05–p95 spread bar.
// Both obligations survive that shrink — suppression becomes the withheld count, the mismatch a
// visible "channel only" tag with the full sentence for screen readers — and so does the third one
// the chart normally carries: bypassing it would drop the percentile method and the bar's p05–p95
// extent, so compact states both in an sr-only line.

import type { MetricDistribution, SessionDistributionResponse } from '@facet/shared';
import type { ReactElement, ReactNode } from 'react';
import { useSessionDistribution } from '../../hooks/insights.js';
import { formatNumber } from '../../lib/format.js';
import { useDashboard } from '../../state.js';
import { ErrorState, PendingNotice, Skeleton } from '../StatusStates.js';
import {
	DistributionChart,
	type DistributionMetric,
	binScale,
	formatMetric,
} from '../charts/Distribution.js';
import type { TileConfig, TileDef, TileDensity } from './types.js';

/** Filters the board can carry that this endpoint structurally cannot honour. */
const UNSUPPORTED = ['path', 'referrer', 'country', 'device'] as const;

const METRIC_LABEL: Record<DistributionMetric, string> = {
	duration: 'Session duration',
	pageviews: 'Pages per session',
};

/**
 * The sentence shown when the board is sliced in a way the session table cannot follow. Returns
 * `null` when the board's filters and this tile's really do agree.
 */
export function filterMismatchNote(active: readonly string[]): string | null {
	if (active.length === 0) return null;
	const list = active.join(', ');
	return `Not sliced by ${list}: sessions are materialized per visit and carry no ${active.length === 1 ? 'such column' : 'such columns'}, so the API refuses that filter rather than answering the unfiltered distribution under a filtered label. Channel filters DO apply.`;
}

function metricOf(config: TileConfig | undefined): DistributionMetric {
	return config?.variant === 'pageviews' ? 'pageviews' : 'duration';
}

function distributionOf(
	data: SessionDistributionResponse,
	metric: DistributionMetric,
): MetricDistribution | null {
	return metric === 'duration' ? data.duration_ms : data.pageviews;
}

/**
 * The p05–p95 range with the middle half boxed and the median ticked, one strip tall.
 *
 * IMPORTANT: positioned through `binScale`, the same per-bin transform the plot uses. On a linear
 * track the first six duration bins collapse into a sliver, which is the exact distortion the chart
 * exists to refuse — a smaller drawing may not quietly reintroduce it.
 */
function SpreadBar({ dist }: { dist: MetricDistribution }): ReactElement {
	const scale = binScale(dist.histogram, dist.max);
	const at = (value: number): number => Math.min(100, Math.max(0, scale.toUnit(value) * 100));
	const p = dist.percentiles;
	const lo = at(p.p05);
	const q1 = at(p.p25);
	const q3 = at(p.p75);
	const hi = at(p.p95);
	return (
		<div
			aria-hidden="true"
			className="relative h-1.5 w-full shrink-0 overflow-hidden rounded-full"
			style={{ backgroundColor: 'rgb(var(--hover))' }}
		>
			<div
				className="absolute inset-y-0 rounded-full"
				style={{
					left: `${lo.toFixed(1)}%`,
					width: `${Math.max(1, hi - lo).toFixed(1)}%`,
					backgroundColor: 'rgb(var(--accent-rgb) / 0.28)',
				}}
			/>
			<div
				className="absolute inset-y-0 rounded-full"
				style={{
					left: `${q1.toFixed(1)}%`,
					width: `${Math.max(1.5, q3 - q1).toFixed(1)}%`,
					backgroundColor: 'rgb(var(--accent-rgb) / 0.62)',
				}}
			/>
			<div
				className="-translate-x-1/2 absolute inset-y-0 w-0.5 rounded-full"
				style={{ left: `${at(p.p50).toFixed(1)}%`, backgroundColor: 'var(--ink)' }}
			/>
		</div>
	);
}

function CompactShell({ children }: { children: ReactNode }): ReactElement {
	return (
		<div className="flex h-full min-h-0 w-full flex-col justify-center gap-0.5 overflow-hidden">
			{children}
		</div>
	);
}

/**
 * The `compact` rendering. The plot needs ~190px of height and the caveat lines under it another 24;
 * under about 130px it is a clipped sliver of a chart whose whole point is that nothing is clipped.
 * So: the median, the interquartile range in words, the spread as one strip, and n.
 *
 * IMPORTANT: a compact tile's body floor is ~36px (FIT_MIN_ROW_PX 64, less the tile's `p-2` and the
 * label overlay's `pt-3`), which is exactly 16 + 2 + 6 + 2 + 10. Nothing may be added to this stack
 * without taking something out, or the shortest tile clips through the middle of the median.
 */
function DistributionCompact({
	data,
	metric,
	note,
}: {
	data: SessionDistributionResponse;
	metric: DistributionMetric;
	note: string | null;
}): ReactElement {
	const dist = distributionOf(data, metric);
	if (data.suppressed || !dist) {
		return (
			<CompactShell>
				<span className="text-[color:var(--ink)] text-xs leading-tight">
					{data.suppressed
						? `${METRIC_LABEL[metric]} withheld · ${formatNumber(data.count)} of ${formatNumber(data.min_count)} sessions needed`
						: `${METRIC_LABEL[metric]} not reported in this response`}
				</span>
			</CompactShell>
		);
	}
	const p = dist.percentiles;
	const fmt = (value: number): string => formatMetric(value, metric);
	return (
		<CompactShell>
			<div className="flex min-w-0 items-baseline gap-x-1.5">
				<span className="tabular shrink-0 font-semibold text-[color:var(--ink)] text-base leading-none tracking-[-0.02em]">
					{fmt(p.p50)}
				</span>
				<span className="truncate text-[10px] text-[color:var(--muted)] leading-none">
					{`median ${METRIC_LABEL[metric].toLowerCase()}`}
				</span>
			</div>
			<SpreadBar dist={dist} />
			<p className="tabular truncate text-[10px] text-[color:var(--faint)] leading-none">
				{`p25–p75 ${fmt(p.p25)}–${fmt(p.p75)} · ${formatNumber(data.count)} sessions`}
				{data.meta?.pending ? ' · materializing' : ''}
				{note ? ' · channel only' : ''}
			</p>
			<p className="sr-only">
				{`The bar spans p05–p95, ${fmt(p.p05)} to ${fmt(p.p95)}. Percentiles are ${data.percentile_method} order statistics — each is a value a real session had, not an interpolated quartile.`}
			</p>
			{note ? <p className="sr-only">{note}</p> : null}
		</CompactShell>
	);
}

/** One statistic in the expanded strip. */
function Stat({ label, value }: { label: string; value: string }): ReactElement {
	return (
		<div className="min-w-0">
			<div className="font-semibold text-[9px] text-[color:var(--faint)] uppercase leading-none tracking-[0.08em]">
				{label}
			</div>
			<div className="tabular mt-1 text-[color:var(--ink)] text-xs leading-none">{value}</div>
		</div>
	);
}

/**
 * The `expanded` extra. Focused, the tile has room to show what the resting chart offers only on
 * hover — and the mean is labelled as the one value here that is not an order statistic, exactly as
 * the chart's own text equivalent labels it.
 */
function StatStrip({
	dist,
	metric,
}: {
	dist: MetricDistribution;
	metric: DistributionMetric;
}): ReactElement {
	const p = dist.percentiles;
	const fmt = (value: number): string => formatMetric(value, metric);
	return (
		<div className="flex shrink-0 flex-wrap gap-x-5 gap-y-3 pt-1" aria-hidden="true">
			<Stat label="Min" value={fmt(dist.min)} />
			<Stat label="p05" value={fmt(p.p05)} />
			<Stat label="p10" value={fmt(p.p10)} />
			<Stat label="p25" value={fmt(p.p25)} />
			<Stat label="Median" value={fmt(p.p50)} />
			<Stat label="p75" value={fmt(p.p75)} />
			<Stat label="p90" value={fmt(p.p90)} />
			<Stat label="p95" value={fmt(p.p95)} />
			<Stat label="p99" value={fmt(p.p99)} />
			<Stat label="Max" value={fmt(dist.max)} />
			<Stat label="Mean (not an order statistic)" value={fmt(dist.mean)} />
		</div>
	);
}

function DistributionBody({
	metric,
	density,
	channel,
	activeUnsupported,
}: {
	metric: DistributionMetric;
	density: TileDensity;
	channel?: string;
	activeUnsupported: string[];
}): ReactElement {
	const { apiKey, siteId, range } = useDashboard();
	const { data, error, isLoading } = useSessionDistribution(apiKey, siteId, range, channel);
	const note = filterMismatchNote(activeUnsupported);
	const compact = density === 'compact';

	if (isLoading && !data) return <Skeleton className="h-full w-full" />;
	if (error || !data) {
		// The full alert card is a `p-4` block with an expandable detail; a compact tile is barely
		// one line tall, so it gets the sentence alone rather than a card clipped to its first line.
		return compact ? (
			<p role="alert" className="text-[color:var(--ink)] text-xs leading-tight">
				Could not load the session distribution
			</p>
		) : (
			<ErrorState
				message="Could not load the session distribution"
				detail={error ? String(error) : undefined}
			/>
		);
	}

	if (compact) return <DistributionCompact data={data} metric={metric} note={note} />;

	const dist = distributionOf(data, metric);
	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-2">
			{data.meta?.pending ? <PendingNotice /> : null}
			<div className="min-h-0 flex-1">
				<DistributionChart data={data} metric={metric} filterNote={note} />
			</div>
			{density === 'expanded' && dist ? <StatStrip dist={dist} metric={metric} /> : null}
		</div>
	);
}

export const distributionBox: TileDef = {
	// No `table`: this box's numbers are not on `ctx`, they come from its own request. The chart
	// already ships every statistic and every bin in its sr-only table, so a second, empty grid here
	// would be worse than none.
	render: (ctx, density, config) => (
		<DistributionBody
			metric={metricOf(config)}
			density={density}
			channel={ctx.cubeFilter.channel}
			activeUnsupported={UNSUPPORTED.filter((key) =>
				key === 'path'
					? Boolean(ctx.serverFilter.path)
					: key === 'referrer'
						? Boolean(ctx.serverFilter.referrer)
						: Boolean(ctx.cubeFilter[key]),
			)}
		/>
	),
};
