// Trends box: one line per dimension value over time, in two styles — a focusable multi-line, and a
// brush-and-zoom with a minimap. Both read `GET /api/stats/timeseries`, which is the only endpoint
// that answers "how did each PATH or REFERRER move over the range" (the cube deliberately excludes
// those two, and the top-N lists have no time axis at all).
//
// This box fetches its own data rather than reading `ctx`: the board's shared context carries one
// `StatsResponse`, and a per-dimension series is a different read with its own dimension + limit.
// The read applies the active SEGMENT in full — see `useDimensionSeries`.
//
// The tiers: `compact` is neither chart. Both need ~190px before the plot has any height left
// (MultiLine keeps a 5rem floor, BrushRange spends 40px on its minimap), so under that they draw a
// legend sitting on nothing. `TrendsCompact` answers what a trend line is for instead: which value
// leads, and what shape it made. `expanded` gives MultiLine's legend room to wrap rather than scroll.

import type { DimensionSeries, Interval, SeriesDimension } from '@facet/shared';
import type { ReactElement } from 'react';
import { useSegment } from '../../hooks/segment.js';
import {
	METRIC_LABEL,
	type SeriesMetric,
	bucketTimes,
	drawableSeries,
	hueOf,
	summarize,
	useDimensionSeries,
} from '../../hooks/timeseries.js';
import { formatNumber } from '../../lib/format.js';
import { SEGMENT_LABELS } from '../../lib/segment.js';
import { useThemeColors } from '../../theme.js';
import { Sparkline } from '../Sparkline.js';
import { ErrorState, Skeleton } from '../StatusStates.js';
import { BrushRange } from '../charts/BrushRange.js';
import { ChartEmpty } from '../charts/ChartChrome.js';
import { MultiLine } from '../charts/MultiLine.js';
import type { TileConfig, TileDef, TileDensity } from './types.js';

const DIMENSION_LABEL: Record<SeriesDimension, string> = {
	path: 'Page',
	referrer: 'Referrer',
	country: 'Country',
	device: 'Device',
	channel: 'Channel',
};

const DIMENSION_CHOICES = Object.entries(DIMENSION_LABEL).map(([value, label]) => ({
	value,
	label,
}));

function dimensionOf(config: TileConfig | undefined): SeriesDimension {
	const value = config?.dimension;
	return DIMENSION_CHOICES.some((d) => d.value === value) ? (value as SeriesDimension) : 'path';
}

function metricOf(config: TileConfig | undefined): SeriesMetric {
	return config?.metric === 'events' ? 'events' : 'pageviews';
}

function linesOf(config: TileConfig | undefined): number {
	const n = Number.parseInt(String(config?.lines ?? '5'), 10);
	return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 5;
}

/**
 * The `compact` rendering: the leading line's name, its total on the metric actually plotted, its
 * share of the shown lines, and its shape across the range. One line drawn rather than eight —
 * eight lines in ~20px of plot is a smudge, and the question a reader can still answer at this size
 * is "who leads, and is it rising".
 *
 * IMPORTANT: the lead is taken from `summarize`, never from `DimensionSeries.total` — that field is
 * pageviews over the range (the server's ranking metric) even when the tile is plotting events.
 */
function TrendsCompact({
	series,
	interval,
	metric,
	dimensionLabel,
	truncated,
}: {
	series: DimensionSeries[];
	interval: Interval;
	metric: SeriesMetric;
	dimensionLabel: string;
	truncated: boolean;
}): ReactElement {
	const theme = useThemeColors();
	const times = bucketTimes(series);
	const rows = summarize(series, metric, 0, times.length - 1);
	let best = 0;
	for (let i = 1; i < rows.length; i++) {
		if ((rows[i]?.total ?? 0) > (rows[best]?.total ?? 0)) best = i;
	}
	const leader = rows[best];
	const line = series[best];
	if (!leader || !line || leader.total === 0) {
		return <ChartEmpty reason="range" compact />;
	}
	const ranked = [...rows].sort((a, b) => b.total - a.total);
	const rest = series.length - 1;

	return (
		<div className="flex h-full min-h-0 flex-col justify-center gap-1">
			<div className="flex items-center gap-2 px-2">
				<span className="min-w-0 truncate font-medium text-[color:var(--ink)] text-xs">
					{leader.key}
				</span>
				{rest > 0 ? (
					<span className="shrink-0 text-[10px] text-[color:var(--faint)]">
						+{rest} more
					</span>
				) : null}
				<span className="ml-auto shrink-0 font-semibold text-[color:var(--ink)] text-sm tabular-nums">
					{formatNumber(leader.total)}
				</span>
				<span className="shrink-0 text-[10px] text-[color:var(--muted)] tabular-nums">
					{Math.round(leader.share * 100)}%
				</span>
			</div>
			<Sparkline
				values={line.points.map((p) => p[metric])}
				stroke={hueOf(theme.cat, best)}
				fill
				className="min-h-[14px] w-full flex-1"
			/>
			<table className="sr-only">
				<caption>
					{METRIC_LABEL[metric]} by {dimensionLabel.toLowerCase()} over time —{' '}
					{series.length} series across {times.length}{' '}
					{interval === 'hour' ? 'hourly' : 'daily'} buckets. At this size the tile plots{' '}
					{leader.key} only.
					{truncated ? ' A longer tail of keys was not returned.' : ''}
				</caption>
				<thead>
					<tr>
						<th scope="col">{dimensionLabel}</th>
						<th scope="col">Total {METRIC_LABEL[metric].toLowerCase()}</th>
						<th scope="col">Share of shown</th>
					</tr>
				</thead>
				<tbody>
					{ranked.map((row) => (
						<tr key={row.key}>
							<th scope="row">{row.key}</th>
							<td>{formatNumber(row.total)}</td>
							<td>{Math.round(row.share * 100)}%</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function TrendsBody({
	config,
	density,
}: {
	config?: TileConfig;
	density: TileDensity;
}): ReactElement {
	const dimension = dimensionOf(config);
	const metric = metricOf(config);
	const limit = linesOf(config);
	const { segment } = useSegment();
	const { data, isLoading, isError, error } = useDimensionSeries({ dimension, limit });

	// The segment can constrain the very dimension the chart splits by (segment `path=/pricing` while
	// splitting by page). That is not a bug — the answer really is one line — but a chart labelled
	// "top 5 pages" showing one line looks like a data fault, so it says which it is.
	const selfFiltered = segment[dimension] !== undefined;

	if (isLoading) return <Skeleton className="h-full w-full" />;
	if (isError) {
		return (
			<ErrorState
				message="Could not load trends"
				detail={error instanceof Error ? error.message : null}
			/>
		);
	}
	// Filtered, not just defaulted: a series without a `points` array is drawn by indexing it, and the
	// resulting throw takes the entire dashboard down rather than this one tile.
	const series = drawableSeries(data?.series);
	const label = DIMENSION_LABEL[dimension];
	const interval = data?.interval ?? 'day';
	const truncated = data?.truncated ?? false;

	// No self-filter note here: the compact tile shows one row with no "+N" beside it, which already
	// says the split has a single answer, and the note needs two lines this tier does not have.
	if (density === 'compact') {
		return (
			<TrendsCompact
				series={series}
				interval={interval}
				metric={metric}
				dimensionLabel={label}
				truncated={truncated}
			/>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col gap-1">
			{selfFiltered ? (
				<p className="shrink-0 text-[11px] text-[color:var(--muted)]">
					Filtered to {SEGMENT_LABELS[dimension]} “{segment[dimension]}”, which is also
					the split — one line is the whole answer.
				</p>
			) : null}
			<div className="min-h-0 flex-1">
				{config?.variant === 'brush' ? (
					<BrushRange
						series={series}
						interval={interval}
						metric={metric}
						dimensionLabel={label}
						truncated={truncated}
					/>
				) : (
					<MultiLine
						series={series}
						interval={interval}
						metric={metric}
						dimensionLabel={label}
						truncated={truncated}
						expanded={density === 'expanded'}
					/>
				)}
			</div>
		</div>
	);
}

export const trendsBox: TileDef = {
	// No `table`: the "view as table" toggle is fed from the board's shared context, and this box's
	// data is its own read — a pure `table(ctx, config)` cannot reach it. The sr-only table inside
	// each rendering carries the numbers instead.
	render: (_ctx, density, config) => <TrendsBody config={config} density={density} />,
};
