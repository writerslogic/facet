// Traffic-over-time box: the hero uPlot chart. Expanded, it reveals a headline stat strip (totals,
// peak bucket, per-bucket average) over the full chart. Compact, it drops the canvas entirely for a
// one-line total + sparkline — see TrafficCompact.

import type { SeriesPoint } from '@facet/shared';
import { type ReactNode, Suspense, lazy } from 'react';
import { formatDayShort, formatIso, formatStamp, useClockMode } from '../../lib/datetime.js';
import {
	type DeltaSense,
	type Movement,
	exactHint,
	formatKpi,
	formatNumber,
} from '../../lib/format.js';
import type { Range } from '../../state.js';
import { DeltaBadge } from '../Delta.js';
import { Sparkline } from '../Sparkline.js';
import type { TimelineAnnotationManager } from '../TimelineNotes.js';
import {
	type ChartAnnotation,
	TrafficChart,
	type TrafficScale,
	type TrafficVariant,
} from '../TrafficChart.js';
import { ChartEmpty } from '../charts/ChartChrome.js';
import { accentOf } from './shared.js';
import type { TileConfig, TileConfigValue, TileDef } from './types.js';

// Timeline management is only visible after the hero tile expands. Keep its forms, category rail,
// and delete-confirmation UI out of the Overview's first-interaction bundle.
const TimelineNotes = lazy(() =>
	import('../TimelineNotes.js').then((module) => ({ default: module.TimelineNotes })),
);

const DAY_MS = 86_400_000;

/** A slot's persisted config is arbitrary stored strings, so both style fields are narrowed rather
 * than asserted — an unknown value falls back to the option's own default. */
function variantOf(value: TileConfigValue | undefined): TrafficVariant {
	return value === 'line' || value === 'bars' || value === 'smooth' ? value : 'area';
}

function scaleOf(value: TileConfigValue | undefined): TrafficScale {
	return value === 'log' ? 'log' : 'linear';
}

/** Resolve a slot's config into the chart's style props (shared by the compact + expanded charts). */
function chartStyle(config?: TileConfig): {
	variant: TrafficVariant;
	scale: TrafficScale;
	trend: boolean;
	accent: string | undefined;
} {
	return {
		variant: variantOf(config?.variant),
		scale: scaleOf(config?.scale),
		trend: Boolean(config?.trend),
		accent: accentOf(config),
	};
}

/** Bucket width implied by the series: the SMALLEST gap between points, never the average. The
 * server zero-fills every bucket, but a cross-filtered series is rebuilt from the cube and drops
 * empty ones, so an average would read a gap as a wider bucket and call an hourly range daily. */
function bucketMsOf(series: SeriesPoint[]): number {
	let smallest = Number.POSITIVE_INFINITY;
	for (let i = 1; i < series.length; i++) {
		const gap = (series[i]?.t ?? 0) - (series[i - 1]?.t ?? 0);
		if (gap > 0 && gap < smallest) smallest = gap;
	}
	return Number.isFinite(smallest) ? smallest : DAY_MS;
}

interface TrafficTotals {
	pageviews: number;
	peak: SeriesPoint | null;
	average: number;
	/** The `24h` preset buckets by hour, so every per-bucket figure has to name which unit it is in. */
	hourly: boolean;
}

/** IMPORTANT: no visitors total here. `point.visitors` is distinct-per-bucket, so summing it counts a
 * visitor once per bucket they appear in; the range-distinct figure is `ctx.summary.visitors`. */
function totalsOf(series: SeriesPoint[], range: Range): TrafficTotals {
	let pageviews = 0;
	let peak: SeriesPoint | null = null;
	for (const point of series) {
		pageviews += point.pageviews;
		if (!peak || point.pageviews > peak.pageviews) peak = point;
	}
	const bucketMs = bucketMsOf(series);
	// Buckets in the REQUESTED range, counted the way the server zero-fills them: a filtered series is
	// rebuilt from the cube and omits its empty buckets, so dividing by the ones that survived (or by
	// the span between the first and last survivor) reports a busier site than the range actually had.
	const aligned = range.start - (range.start % bucketMs);
	const buckets = Math.max(1, Math.ceil((range.end - aligned) / bucketMs));
	return {
		pageviews,
		peak,
		average: Math.round(pageviews / buckets),
		hourly: bucketMs < DAY_MS,
	};
}

function peakLabel(totals: TrafficTotals): string {
	if (!totals.peak) return '—';
	return totals.hourly ? formatStamp(totals.peak.t) : formatDayShort(totals.peak.t);
}

function movementOf(delta: number | null, sense: DeltaSense): Movement | null {
	// The board hands deltas down as whole percents (see `pct` in App.tsx); the badge works in fractions.
	return delta == null ? null : { kind: 'pct', value: delta / 100, sense };
}

/** One headline figure in the expanded traffic view. The diamond keys the series colour, so the strip
 * doubles as the chart legend. */
function DetailStat({
	label,
	value,
	sub,
	stroke,
}: {
	label: string;
	value: string;
	sub?: string;
	stroke?: string;
}): ReactNode {
	return (
		<div className="rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] px-3 py-2">
			<div className="flex items-center gap-1.5 text-[10px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em]">
				{stroke ? (
					<span
						className="inline-block size-1.5 rotate-45 rounded-[1px]"
						style={{ background: stroke }}
						aria-hidden="true"
					/>
				) : null}
				{label}
			</div>
			<div className="tabular mt-0.5 font-semibold text-2xl text-[color:var(--ink)] leading-none">
				{value}
			</div>
			{sub ? <div className="mt-0.5 text-[11px] text-[color:var(--muted)]">{sub}</div> : null}
		</div>
	);
}

/**
 * The `compact` rendering. A uPlot canvas spends ~44px on its y-axis and a row on its x labels before
 * it can plot anything, so in the 56–132px band the hero was drawing chrome around a sliver — and at
 * the bottom of it (a tile squeezed by a focused neighbour) nothing at all. Answer the question the
 * timeline exists to answer instead: how much traffic the range carried, which way it moved, and the
 * shape it moved in. Dropping the canvas also stops a neighbour's focus rebuilding it twice.
 */
function TrafficCompact({
	series,
	visitors,
	range,
	delta,
	sense,
	config,
}: {
	series: SeriesPoint[];
	visitors: number;
	range: Range;
	delta: number | null;
	sense: DeltaSense;
	config?: TileConfig;
}): ReactNode {
	// REQUIRED: the screen-reader peak line stamps an instant, so a clock flip has to re-render it.
	useClockMode();
	if (series.length === 0)
		return <ChartEmpty reason="range" compact title="No traffic in this range" />;
	const totals = totalsOf(series, range);
	// YAGNI: `style.trend` has no compact form. Sparkline draws one polyline, and a second series in
	// ~36px of body would bury the shape the spark exists to show.
	const style = chartStyle(config);
	const values = series.map((point) =>
		style.scale === 'log' ? Math.log10(point.pageviews + 1) : point.pageviews,
	);
	const exact = exactHint(totals.pageviews);
	return (
		<div className="flex h-full items-center gap-2 overflow-hidden">
			<span
				className="tabular shrink-0 font-semibold text-[color:var(--ink)] text-lg leading-none tracking-[-0.02em]"
				title={exact ?? undefined}
			>
				{formatKpi(totals.pageviews)}
			</span>
			<span className="shrink-0 font-semibold text-[10px] text-[color:var(--muted)] uppercase leading-none tracking-[0.08em]">
				pageviews
			</span>
			<div className="h-full min-h-0 min-w-0 flex-1 py-1 @max-[18rem]/tile:hidden">
				<Sparkline
					values={values}
					stroke={style.accent ?? 'var(--d1)'}
					fill={style.variant === 'area' || style.variant === 'smooth'}
					marker
					className="h-full w-full"
				/>
			</div>
			<DeltaBadge
				movement={movementOf(delta, sense)}
				size="sm"
				className="ml-auto shrink-0"
			/>
			<p className="sr-only">
				{formatNumber(visitors)} visitors. Peak {peakLabel(totals)}:{' '}
				{formatNumber(totals.peak?.pageviews ?? 0)} pageviews.
			</p>
		</div>
	);
}

function TrafficDetail({
	series,
	visitors,
	range,
	annotations,
	annotationManager,
	config,
}: {
	series: SeriesPoint[];
	visitors: number;
	range: Range;
	annotations: ChartAnnotation[];
	annotationManager: TimelineAnnotationManager;
	config?: TileConfig;
}): ReactNode {
	// REQUIRED: the peak stat stamps an instant, so a clock flip has to re-render the strip.
	useClockMode();
	const totals = totalsOf(series, range);
	const per = totals.hourly ? 'hour' : 'day';
	return (
		<div className="flex h-full flex-col gap-3">
			<div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
				<DetailStat
					label="Pageviews"
					value={formatNumber(totals.pageviews)}
					stroke="var(--d1)"
				/>
				<DetailStat label="Visitors" value={formatNumber(visitors)} stroke="var(--d2)" />
				<DetailStat
					label={`Peak / ${per}`}
					value={formatNumber(totals.peak?.pageviews ?? 0)}
					sub={peakLabel(totals)}
				/>
				<DetailStat label={`Avg / ${per}`} value={formatNumber(totals.average)} />
			</div>
			<div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_19rem]">
				<div className="min-h-0">
					<TrafficChart
						bare
						series={series}
						annotations={annotations}
						loading={false}
						error={null}
						zoomable
						{...chartStyle(config)}
					/>
				</div>
				<Suspense
					fallback={
						<div className="animate-pulse rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))]" />
					}
				>
					<TimelineNotes manager={annotationManager} />
				</Suspense>
			</div>
		</div>
	);
}

export const trafficBox: TileDef = {
	table: (ctx) => {
		// An hourly range collapsed to 24 rows all stamped with the same date until the column carried
		// the hour. UTC either way: the attribute-grade instant, not the reader's clock.
		const hourly = bucketMsOf(ctx.series) < DAY_MS;
		return {
			columns: [hourly ? 'Hour (UTC)' : 'Date (UTC)', 'Pageviews', 'Visitors'],
			rows: ctx.series.map((p) => [
				formatIso(p.t).slice(0, hourly ? 16 : 10),
				p.pageviews,
				p.visitors,
			]),
		};
	},
	action: (ctx) => {
		const anomalyCount = ctx.annotations.filter((item) => item.kind === 'anomaly').length;
		const noteCount = ctx.annotationManager.notes.length;
		return noteCount > 0 || anomalyCount > 0 ? (
			<span className="inline-flex items-center gap-2 text-[11px] text-[color:var(--muted)]">
				{noteCount > 0 ? (
					<span className="inline-flex items-center gap-1">
						<span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--d2)]" />
						{noteCount} {noteCount === 1 ? 'note' : 'notes'}
					</span>
				) : null}
				{anomalyCount > 0 ? (
					<span className="inline-flex items-center gap-1">
						<span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--neg)]" />
						{anomalyCount} {anomalyCount === 1 ? 'anomaly' : 'anomalies'}
					</span>
				) : null}
			</span>
		) : (
			<span className="text-[11px] text-[color:var(--muted)]">Add context when expanded</span>
		);
	},
	render: (ctx, density, config) => {
		if (density === 'expanded')
			return (
				<TrafficDetail
					series={ctx.series}
					visitors={ctx.summary.visitors}
					range={ctx.annotationManager.range}
					annotations={ctx.annotations}
					annotationManager={ctx.annotationManager}
					config={config}
				/>
			);
		if (density === 'compact')
			return (
				<TrafficCompact
					series={ctx.series}
					visitors={ctx.summary.visitors}
					range={ctx.annotationManager.range}
					delta={ctx.deltas.pv}
					sense={ctx.sense(ctx.deltas.pv)}
					config={config}
				/>
			);
		return (
			<TrafficChart
				bare
				series={ctx.series}
				annotations={ctx.annotations}
				loading={false}
				error={null}
				{...chartStyle(config)}
			/>
		);
	},
};
