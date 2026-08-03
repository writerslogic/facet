// Trends box: one line per dimension value over time, in two styles — a focusable multi-line, and a
// brush-and-zoom with a minimap. Both read `GET /api/stats/timeseries`, which is the only endpoint
// that answers "how did each PATH or REFERRER move over the range" (the cube deliberately excludes
// those two, and the top-N lists have no time axis at all).
//
// This box fetches its own data rather than reading `ctx`: the board's shared context carries one
// `StatsResponse`, and a per-dimension series is a different read with its own dimension + limit.
// The read applies the active SEGMENT in full — see `useDimensionSeries`.

import type { SeriesDimension } from '@facet/shared';
import { type ReactElement, useId } from 'react';
import { useSegment } from '../../hooks/segment.js';
import { type SeriesMetric, drawableSeries, useDimensionSeries } from '../../hooks/timeseries.js';
import { SEGMENT_LABELS } from '../../lib/segment.js';
import { ErrorState, Skeleton } from '../StatusStates.js';
import { BrushRange } from '../charts/BrushRange.js';
import { MultiLine } from '../charts/MultiLine.js';
import type { TileConfig, TileDef, TileOption, TileVariant } from './types.js';

const DIMENSIONS: { value: SeriesDimension; label: string }[] = [
	{ value: 'path', label: 'Page' },
	{ value: 'referrer', label: 'Referrer' },
	{ value: 'country', label: 'Country' },
	{ value: 'device', label: 'Device' },
	{ value: 'channel', label: 'Channel' },
];

const DIMENSION_LABEL: Record<SeriesDimension, string> = {
	path: 'Page',
	referrer: 'Referrer',
	country: 'Country',
	device: 'Device',
	channel: 'Channel',
};

const VARIANTS: TileVariant[] = [
	{ id: 'focus', label: 'Focus lines' },
	{ id: 'brush', label: 'Brush + zoom' },
];

const OPTIONS: TileOption[] = [
	{
		key: 'dimension',
		label: 'Split by',
		type: 'select',
		choices: DIMENSIONS.map((d) => ({ value: d.value, label: d.label })),
		default: 'path',
	},
	{
		key: 'metric',
		label: 'Metric',
		type: 'select',
		// Pageviews and events only. `/api/stats/timeseries` returns no visitors field: a
		// per-(key, bucket) distinct-visitor count is non-additive along both axes, so a line chart
		// that invites summing it would be wrong in its most common reading. Nothing here synthesises
		// one from what is returned.
		choices: [
			{ value: 'pageviews', label: 'Pageviews' },
			{ value: 'events', label: 'Events' },
		],
		default: 'pageviews',
	},
	{
		key: 'lines',
		label: 'Lines',
		type: 'select',
		// The endpoint's own bound is 1–8 and it 400s outside it rather than clamping.
		choices: [
			{ value: '3', label: 'Top 3' },
			{ value: '5', label: 'Top 5' },
			{ value: '8', label: 'Top 8' },
		],
		default: '5',
	},
];

function dimensionOf(config: TileConfig | undefined): SeriesDimension {
	const value = config?.dimension;
	return DIMENSIONS.some((d) => d.value === value) ? (value as SeriesDimension) : 'path';
}

function metricOf(config: TileConfig | undefined): SeriesMetric {
	return config?.metric === 'events' ? 'events' : 'pageviews';
}

function linesOf(config: TileConfig | undefined): number {
	const n = Number.parseInt(String(config?.lines ?? '5'), 10);
	return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 5;
}

function TrendsBody({
	config,
	expanded,
}: {
	config?: TileConfig;
	expanded?: boolean;
}): ReactElement {
	const dimension = dimensionOf(config);
	const metric = metricOf(config);
	const limit = linesOf(config);
	const noteId = useId();
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

	return (
		<div className="flex h-full min-h-0 flex-col gap-1">
			{selfFiltered ? (
				<p id={noteId} className="shrink-0 text-[11px] text-[color:var(--muted)]">
					Filtered to {SEGMENT_LABELS[dimension]} “{segment[dimension]}”, which is also
					the split — one line is the whole answer.
				</p>
			) : null}
			<div className="min-h-0 flex-1">
				{config?.variant === 'brush' ? (
					<BrushRange
						series={series}
						interval={data?.interval ?? 'day'}
						metric={metric}
						dimensionLabel={label}
						truncated={data?.truncated ?? false}
					/>
				) : (
					<MultiLine
						series={series}
						interval={data?.interval ?? 'day'}
						metric={metric}
						dimensionLabel={label}
						truncated={data?.truncated ?? false}
						expanded={expanded}
					/>
				)}
			</div>
		</div>
	);
}

export const trendsBox: TileDef = {
	id: 'trends',
	title: 'Trends by dimension',
	size: 'wide',
	expandable: true,
	variants: VARIANTS,
	options: OPTIONS,
	// No `table`: the "view as table" toggle is fed from the board's shared context, and this box's
	// data is its own read. The sr-only table inside each chart carries the numbers instead.
	render: (_ctx, expanded, config) => <TrendsBody config={config} expanded={expanded} />,
};
