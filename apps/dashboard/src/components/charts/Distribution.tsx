// Session duration and pages-per-session as a box-and-whisker over a stepped violin.
//
// THE PERCENTILES ARE NOT QUARTILES. The response says so in `percentile_method`:
// `nearest-rank-lower` means `percentiles[p]` is the value at index `floor(p × (n − 1))` of the
// ascending sample — an ORDER STATISTIC, a value some session actually had. A conventional box plot
// draws interpolated hinges, and interpolating these eight numbers to "improve" them would invent
// values no session ever recorded, in a chart whose whole selling point is that it did not. So:
//
//   * every mark is drawn at the value the server sent, unaltered;
//   * the box edges are drawn as TICKED rules rather than a smooth box, because the reader should
//     see eight discrete observations, not a continuous hinge;
//   * p10/p90/p99 get their own ticks — the response carries eleven statistics and hiding three of
//     them would be the same kind of quiet editing;
//   * the caption states the method verbatim, in the visible chart and in the sr-only table.
//
// THE VIOLIN IS THE HISTOGRAM, NOT A KERNEL. `histogram` bins partition the metric's whole domain
// and sum to `count`, so the density is drawn as a mirrored STEP through the bin counts. A smoothed
// curve would put ink between bin edges where the API resolved nothing, which is the same invention
// in a prettier form.
//
// THE AXIS IS PER-BIN, NOT LINEAR. Duration bins are 1s/5s/15s/30s/1m/2m/5m/10m/30m — geometric. On
// a linear axis the first six bins collapse into a sliver and the chart says nothing about the
// sessions that make up most of the traffic. Each bin therefore gets one equal-width slot and values
// map linearly within their bin (`binScale`); ticks carry the real edge values and the axis is
// labelled non-linear. Because slots are equal width, bar HEIGHT is proportional to bin count and
// therefore to bin area — the usual unequal-bin distortion cannot arise.

import type {
	DistributionBucket,
	DistributionPercentile,
	MetricDistribution,
	SessionDistributionResponse,
} from '@facet/shared';
import { type ReactElement, useMemo, useRef } from 'react';
import { useHoverTarget, useSpring } from '../../lib/chartInteraction.js';
import { formatNumber } from '../../lib/format.js';
import { useSize } from '../../lib/useSize.js';
import { ChartStateLead } from './ChartChrome.js';
import { ChartTooltip, TooltipRow } from './ChartTooltip.js';

export type DistributionMetric = 'duration' | 'pageviews';

/** Ascending, exactly the set the endpoint reports. All eleven statistics get drawn. */
const LEVELS: DistributionPercentile[] = ['p05', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95', 'p99'];

/** Format a value in the metric's own units. Durations are milliseconds. */
export function formatMetric(value: number, metric: DistributionMetric): string {
	if (metric === 'pageviews') return formatNumber(value);
	if (value < 1000) return `${Math.round(value)}ms`;
	const seconds = value / 1000;
	if (seconds < 60) return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
	const minutes = seconds / 60;
	if (minutes < 60) return `${minutes >= 10 ? Math.round(minutes) : minutes.toFixed(1)}m`;
	return `${(minutes / 60).toFixed(1)}h`;
}

/** Label for a bin's lower edge; the open final bin is written `30m+`. */
export function binLabel(bucket: DistributionBucket, metric: DistributionMetric): string {
	return bucket.to == null
		? `${formatMetric(bucket.from, metric)}+`
		: `${formatMetric(bucket.from, metric)}–${formatMetric(bucket.to, metric)}`;
}

export interface BinScale {
	/** Value → `[0, 1]` across the plot. Monotone, piecewise linear, one equal slot per bin. */
	toUnit: (value: number) => number;
	/** Upper edge used for the open-ended final bin — the observed maximum, never a made-up number. */
	openEdge: number;
	bins: readonly DistributionBucket[];
}

/**
 * The per-bin axis. The final bin has no upper edge in the response, so its nominal edge is the
 * distribution's own `max`: a value a session really reached, not an extrapolation. (If `max` does
 * not exceed the bin's lower edge — possible only when the bin is empty — the slot is given a
 * nominal width so the transform stays monotone and total.)
 */
export function binScale(bins: readonly DistributionBucket[], max: number): BinScale {
	const count = bins.length;
	const last = bins[count - 1];
	// The open bin's nominal edge is the observed maximum — a value a session really reached. Only
	// when the bin is empty (max at or below its lower edge) does it fall back to a nominal width, and
	// then only to keep the transform monotone and total.
	const openEdge = last == null ? 1 : max > last.from ? max : last.from + Math.max(1, last.from);
	const toUnit = (value: number): number => {
		if (count === 0) return 0;
		for (let i = 0; i < count; i++) {
			const bin = bins[i] as DistributionBucket;
			const upper = bin.to ?? openEdge;
			if (value < bin.from) return i / count;
			if (value < upper || i === count - 1) {
				const span = upper - bin.from;
				const within = span > 0 ? Math.min(1, Math.max(0, (value - bin.from) / span)) : 0.5;
				return (i + within) / count;
			}
		}
		return 1;
	};
	return { toUnit, openEdge, bins };
}

export interface DistributionChartProps {
	data: SessionDistributionResponse;
	metric: DistributionMetric;
	/** Rendered under the chart when the board carries filters this endpoint cannot honour. */
	filterNote?: string | null;
}

const W = 480;
const H = 190;
const PAD = { top: 12, right: 16, bottom: 26, left: 16 };
const PLOT_W = W - PAD.left - PAD.right;
const VIOLIN_H = 96;
const BOX_Y = PAD.top + VIOLIN_H + 26;
const BOX_H = 26;

const METRIC_LABEL: Record<DistributionMetric, string> = {
	duration: 'Session duration',
	pageviews: 'Pages per session',
};

/**
 * The suppression panel. `suppressed` is not "no data" — it is "the statistics exist and are being
 * withheld", and the reason is specific: eleven order statistics over fewer than 25 sessions ARE the
 * sample re-encoded. Saying that is the difference between a floor a reader can work with and an
 * empty box they will read as a bug.
 */
function Suppressed({ data }: { data: SessionDistributionResponse }): ReactElement {
	return (
		<div className="flex h-full w-full flex-col justify-center gap-2 p-1">
			{/* The same shield + lead every withheld state on the board wears; what follows it is this
			    box's own, far more specific explanation. */}
			<ChartStateLead
				reason="suppressed"
				title={`Withheld: ${formatNumber(data.count)} of ${formatNumber(data.min_count)} sessions needed`}
			/>
			<p className="text-[color:var(--muted)] text-xs leading-relaxed">
				This distribution reports eleven order statistics. Below about eleven observations
				that vector <em>is</em> the raw sample re-encoded — every session's duration would
				be readable straight off the chart. The server therefore emits nothing until{' '}
				{formatNumber(data.min_count)} sessions match, a higher floor than the 3 used for
				the breakdown lists, and returns only the count you see here.
			</p>
			<p className="text-[color:var(--faint)] text-xs">
				Widen the date range, or drop the channel filter, to clear the floor.
			</p>
			<div
				className="h-1.5 w-full overflow-hidden rounded-full"
				style={{ backgroundColor: 'rgb(var(--hover))' }}
			>
				<div
					className="h-full rounded-full"
					style={{
						width: `${Math.min(100, (data.count / Math.max(1, data.min_count)) * 100)}%`,
						backgroundColor: 'rgb(var(--accent-rgb) / 0.62)',
					}}
				/>
			</div>
			<p className="sr-only">
				Session distribution suppressed: {formatNumber(data.count)} sessions matched, and
				the anonymity floor is {formatNumber(data.min_count)}. No percentiles were returned.
			</p>
		</div>
	);
}

export function DistributionChart({
	data,
	metric,
	filterNote,
}: DistributionChartProps): ReactElement {
	const wrap = useRef<HTMLDivElement>(null);
	// The PLOT box, not the whole component: the caveat lines below the drawing take vertical space,
	// and measuring the outer box made the letterbox transform — and therefore the hit-testing —
	// disagree with what the browser actually drew whenever height was the limiting dimension.
	const plot = useRef<HTMLDivElement>(null);
	const size = useSize(plot);
	const boxWidth = size.width || W;
	const boxHeight = size.height || H;

	const dist: MetricDistribution | null =
		metric === 'duration' ? data.duration_ms : data.pageviews;
	// One spring, driven by which metric is showing: it dips to 0 the instant the metric changes and
	// settles back to 1, so the marks re-grow into place instead of teleporting between two scales.
	const metricIndex = metric === 'duration' ? 0 : 1;
	const settleTarget = useSpring(metricIndex, { stiffness: 190, damping: 24 });
	const settle = Math.max(0, 1 - Math.min(1, Math.abs(settleTarget - metricIndex) * 2));

	const scale = useMemo(() => (dist ? binScale(dist.histogram, dist.max) : null), [dist]);
	const maxBin = dist ? dist.histogram.reduce((m, b) => Math.max(m, b.count), 0) || 1 : 1;

	const { hover, handlers } = useHoverTarget<DistributionBucket>(plot, (localX) => {
		if (!dist || dist.histogram.length === 0) return null;
		const s = Math.min(boxWidth / W, boxHeight / H);
		const offsetX = (boxWidth - W * s) / 2;
		const vx = (localX - offsetX) / s - PAD.left;
		const index = Math.floor((vx / PLOT_W) * dist.histogram.length);
		return dist.histogram[index] ?? null;
	});

	if (data.suppressed || !dist || !scale) {
		return (
			<div ref={wrap} className="h-full w-full">
				<Suppressed data={data} />
			</div>
		);
	}

	const xOf = (value: number): number => PAD.left + scale.toUnit(value) * PLOT_W;
	const slot = PLOT_W / dist.histogram.length;
	const p = dist.percentiles;
	const median = BOX_Y + BOX_H / 2;

	// Every mark, with the tick it draws — the three the conventional five-number summary drops are
	// drawn as short ticks rather than omitted.
	const marks: { level: string; value: number; kind: 'edge' | 'tick' | 'median' }[] = [
		{ level: 'p05', value: p.p05, kind: 'edge' },
		{ level: 'p10', value: p.p10, kind: 'tick' },
		{ level: 'p25', value: p.p25, kind: 'edge' },
		{ level: 'p50', value: p.p50, kind: 'median' },
		{ level: 'p75', value: p.p75, kind: 'edge' },
		{ level: 'p90', value: p.p90, kind: 'tick' },
		{ level: 'p95', value: p.p95, kind: 'edge' },
		{ level: 'p99', value: p.p99, kind: 'tick' },
	];

	// Mirrored step through the bin counts: flat across each bin, a vertical jump at each edge.
	const violin = (() => {
		const top: string[] = [];
		const bottom: string[] = [];
		const mid = PAD.top + VIOLIN_H / 2;
		dist.histogram.forEach((bin, i) => {
			const half = ((bin.count / maxBin) * (VIOLIN_H / 2) - 0.5) * settle;
			const x0 = PAD.left + i * slot;
			const x1 = x0 + slot;
			const h = Math.max(0.5, half);
			top.push(
				`${x0.toFixed(1)},${(mid - h).toFixed(1)}`,
				`${x1.toFixed(1)},${(mid - h).toFixed(1)}`,
			);
			bottom.unshift(
				`${x1.toFixed(1)},${(mid + h).toFixed(1)}`,
				`${x0.toFixed(1)},${(mid + h).toFixed(1)}`,
			);
		});
		return `M${top.join(' L')} L${bottom.join(' L')} Z`;
	})();

	const lastBin = dist.histogram[dist.histogram.length - 1];
	const caption = `${METRIC_LABEL[metric]} over ${formatNumber(data.count)} sessions. Percentiles are ${data.percentile_method} order statistics — each is a value a real session had, not an interpolated quartile.`;

	return (
		<div ref={wrap} className="relative flex h-full w-full flex-col" {...handlers}>
			<div ref={plot} className="min-h-0 w-full flex-1">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					preserveAspectRatio="xMidYMid meet"
					className="h-full w-full"
					role="img"
					aria-label={caption}
				>
					{/* Bin slots, so the reader can see the axis is per-bin and where each edge falls. */}
					{dist.histogram.map((bin, i) => (
						<rect
							key={`${bin.from}-${bin.to ?? 'open'}`}
							x={PAD.left + i * slot}
							y={PAD.top}
							width={slot}
							height={VIOLIN_H}
							fill={i % 2 === 0 ? 'rgb(var(--hover))' : 'transparent'}
							fillOpacity={0.5}
						>
							<title>{`${binLabel(bin, metric)}: ${formatNumber(bin.count)} sessions`}</title>
						</rect>
					))}
					<path
						d={violin}
						fill="rgb(var(--accent-rgb) / 0.4)"
						stroke="rgb(var(--accent-rgb) / 0.62)"
						strokeWidth={1}
					/>
					{/* Whisker: p05 → p95. Not min → max; those are drawn as their own dots so an extreme
				    single session cannot be mistaken for the body of the distribution. */}
					<line
						x1={xOf(p.p05)}
						x2={xOf(p.p95)}
						y1={median}
						y2={median}
						stroke="var(--muted)"
						strokeWidth={1}
						opacity={settle}
					/>
					<rect
						x={Math.min(xOf(p.p25), xOf(p.p75))}
						y={BOX_Y}
						width={Math.max(1, Math.abs(xOf(p.p75) - xOf(p.p25)))}
						height={BOX_H}
						rx={2}
						fill="rgb(var(--accent-rgb) / 0.28)"
						stroke="rgb(var(--accent-rgb) / 0.62)"
						strokeWidth={1}
						opacity={settle}
					/>
					{marks.map((mark) => {
						const x = xOf(mark.value);
						const half =
							mark.kind === 'median'
								? BOX_H / 2 + 3
								: mark.kind === 'edge'
									? BOX_H / 2
									: BOX_H / 4;
						return (
							<g key={mark.level} opacity={settle}>
								<line
									x1={x}
									x2={x}
									y1={median - half}
									y2={median + half}
									stroke={mark.kind === 'median' ? 'var(--ink)' : 'var(--muted)'}
									strokeWidth={mark.kind === 'median' ? 2 : 1}
								/>
								<title>{`${mark.level} = ${formatMetric(mark.value, metric)}`}</title>
							</g>
						);
					})}
					{/* min, max and the mean, so the eight order statistics are never mistaken for the
				    whole summary the response carries. */}
					{[
						{ label: 'min', value: dist.min },
						{ label: 'max', value: dist.max },
					].map((point) => (
						<circle
							key={point.label}
							cx={xOf(point.value)}
							cy={median}
							r={2.5}
							fill="var(--faint)"
							opacity={settle}
						>
							<title>{`${point.label} = ${formatMetric(point.value, metric)}`}</title>
						</circle>
					))}
					<g opacity={settle}>
						<path
							d={`M${xOf(dist.mean)},${median - 5} L${xOf(dist.mean) + 4},${median} L${xOf(dist.mean)},${median + 5} L${xOf(dist.mean) - 4},${median} Z`}
							fill="none"
							stroke="var(--ink)"
							strokeWidth={1}
						/>
						<title>{`mean = ${formatMetric(dist.mean, metric)} (the one mark here that is not an order statistic)`}</title>
					</g>
					{/* Bin edge ticks. The final bin is dashed: it is open-ended, and its right edge is the
				    observed maximum rather than a real boundary. */}
					{dist.histogram.map((bin, i) => (
						<text
							key={`edge-${bin.from}`}
							x={PAD.left + i * slot + slot / 2}
							y={H - 6}
							textAnchor="middle"
							className="text-[7px]"
							fill="var(--faint)"
						>
							{bin.to == null
								? `${formatMetric(bin.from, metric)}+`
								: formatMetric(bin.from, metric)}
						</text>
					))}
					{lastBin ? (
						<line
							x1={PAD.left + PLOT_W - slot}
							x2={PAD.left + PLOT_W - slot}
							y1={PAD.top}
							y2={PAD.top + VIOLIN_H}
							stroke="var(--faint)"
							strokeDasharray="3 3"
							strokeWidth={0.8}
						/>
					) : null}
				</svg>
			</div>
			{/* The two caveats are HTML, not <text> inside the viewBox. Scaled with the drawing they
			    became unreadable on a small tile — and these are precisely the two lines that must not
			    be lost, since they are what stops the chart being read as an ordinary box plot on a
			    linear axis. */}
			<p className="shrink-0 text-[10px] text-[color:var(--faint)] leading-snug">
				Axis is one slot per histogram bin, not linear — the bins are unequal by design.{' '}
				{`Percentiles are ${data.percentile_method} order statistics, not interpolated quartiles.`}
			</p>
			{filterNote ? (
				<p className="shrink-0 text-[10px] text-[color:var(--faint)] leading-snug">
					{filterNote}
				</p>
			) : null}
			{hover ? (
				<ChartTooltip
					x={hover.x}
					y={hover.y}
					containerWidth={boxWidth}
					containerHeight={boxHeight}
				>
					<p className="mb-1 font-semibold">{binLabel(hover.datum, metric)}</p>
					<TooltipRow
						label="Sessions"
						value={formatNumber(hover.datum.count)}
						swatch="rgb(var(--accent-rgb) / 0.62)"
					/>
					<TooltipRow
						label="Share"
						value={
							data.count > 0
								? `${Math.round((hover.datum.count / data.count) * 100)}%`
								: '—'
						}
					/>
					{hover.datum.to == null ? (
						<p className="mt-1 text-[color:var(--muted)]">
							Open-ended bin; its right edge is the observed maximum.
						</p>
					) : null}
				</ChartTooltip>
			) : null}
			<table className="sr-only">
				<caption>{caption}</caption>
				<thead>
					<tr>
						<th scope="col">Statistic</th>
						<th scope="col">Value</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">Sessions</th>
						<td>{formatNumber(data.count)}</td>
					</tr>
					<tr>
						<th scope="row">Minimum</th>
						<td>{formatMetric(dist.min, metric)}</td>
					</tr>
					{LEVELS.map((level) => (
						<tr key={level}>
							<th scope="row">{level}</th>
							<td>{formatMetric(p[level], metric)}</td>
						</tr>
					))}
					<tr>
						<th scope="row">Maximum</th>
						<td>{formatMetric(dist.max, metric)}</td>
					</tr>
					<tr>
						<th scope="row">Mean (not an order statistic)</th>
						<td>{formatMetric(dist.mean, metric)}</td>
					</tr>
					{dist.histogram.map((bin) => (
						<tr key={`bin-${bin.from}`}>
							<th scope="row">{`Sessions in ${binLabel(bin, metric)}`}</th>
							<td>{formatNumber(bin.count)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
