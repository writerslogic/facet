// Segments box: the packed bubble field over one cube axis (channel, device or country).
//
// Every value comes from the cube the board already holds, and all of them are additive counts, so
// the rates below are exact rather than estimates:
//
//   area — pageviews, the same volume the ranked lists show.
//   x    — events per pageview: a ratio of two totals, which no ranked list can show.
//   y    — momentum, `(second half − first half) / total` of that segment's OWN pageviews, bounded
//          to [−1, +1], so a small segment doubling and a large one doubling land at the same height.
//
// `visitors` is deliberately unused: the cube documents it as non-additive across cells, so summing
// it would quietly bias any per-visitor rate.

import type { CubeCell, SeriesPoint } from '@facet/shared';
import { type ReactElement, useMemo } from 'react';
import { cn } from '../../lib/cn.js';
import type { CubeAxis, CubeFilter } from '../../lib/cube.js';
import { formatNumber } from '../../lib/format.js';
import { type BubbleDatum, BubbleField } from '../charts/Bubble.js';
import { ChartEmpty, ChartNote } from '../charts/ChartChrome.js';
import type { TileConfig, TileDef, TileDensity } from './types.js';

/** How many bubbles the field draws. The rest stay in the sr-only table and the footnote count. */
const DRAWN = 14;
/** Focused, the field has the area to separate a longer tail. */
const DRAWN_EXPANDED = 28;

const AXIS_LABEL: Record<CubeAxis, string> = {
	channel: 'Channel',
	device: 'Device',
	country: 'Country',
};
const AXIS_NOUN: Record<CubeAxis, [one: string, many: string]> = {
	channel: ['channel', 'channels'],
	device: ['device', 'devices'],
	country: ['country', 'countries'],
};

export interface SegmentBubble extends BubbleDatum {
	pageviews: number;
	events: number;
	firstHalf: number;
	secondHalf: number;
}

/**
 * The share of a bucket's pageviews that falls after `midpoint`.
 *
 * IMPORTANT: a bucket is a span, not an instant. An odd bucket count puts the window's centre inside
 * one bucket, and handing that whole bucket to one side is what made a perfectly flat segment read as
 * +14% momentum across a seven-day range. `bucketMs` of 0 means the caller could not infer a width,
 * and restores the whole-bucket split.
 */
function lateShare(start: number, midpoint: number, bucketMs: number): number {
	if (start >= midpoint) return 1;
	const end = start + bucketMs;
	return bucketMs > 0 && end > midpoint ? (end - midpoint) / bucketMs : 0;
}

/**
 * Aggregate the cube onto one axis, keeping the two rates the field plots.
 *
 * The filter semantics match `cubeBreakdown`: every other axis's constraint applies, this axis's own
 * does not — so cross-filtering re-ranks the field while every value of the plotted axis stays
 * visible (and the selected one stays clickable to toggle off).
 */
export function segmentBubbles(
	cells: readonly CubeCell[],
	filter: CubeFilter,
	axis: CubeAxis,
	midpoint: number,
	bucketMs = 0,
): SegmentBubble[] {
	const others: CubeFilter = { ...filter, [axis]: undefined };
	const matches = (cell: CubeCell): boolean =>
		(others.device === undefined || cell.device === others.device) &&
		(others.country === undefined || cell.country === others.country) &&
		(others.channel === undefined || cell.channel === others.channel);

	const totals = new Map<
		string,
		{ pageviews: number; events: number; first: number; second: number }
	>();
	for (const cell of cells) {
		if (!matches(cell)) continue;
		const key = cell[axis];
		const acc = totals.get(key) ?? { pageviews: 0, events: 0, first: 0, second: 0 };
		acc.pageviews += cell.pageviews;
		acc.events += cell.events;
		const late = lateShare(cell.t, midpoint, bucketMs);
		acc.first += cell.pageviews * (1 - late);
		acc.second += cell.pageviews * late;
		totals.set(key, acc);
	}

	return [...totals.entries()]
		.map(([key, acc]) => ({
			key,
			label: key,
			value: acc.pageviews,
			x: acc.pageviews > 0 ? acc.events / acc.pageviews : 0,
			y: acc.pageviews > 0 ? (acc.second - acc.first) / acc.pageviews : 0,
			pageviews: acc.pageviews,
			events: acc.events,
			firstHalf: acc.first,
			secondHalf: acc.second,
		}))
		.sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1));
}

/** Site-wide events per pageview over the same slice — the quadrant divider on the x axis. */
export function overallRate(rows: readonly SegmentBubble[]): number | null {
	let pageviews = 0;
	let events = 0;
	for (const row of rows) {
		pageviews += row.pageviews;
		events += row.events;
	}
	return pageviews > 0 ? events / pageviews : null;
}

const formatRate = (value: number): string => value.toFixed(2);
const formatMomentum = (value: number): string =>
	`${value > 0 ? '+' : ''}${Math.round(value * 100)}%`;

/** Pageviews a segment shifted between the halves. Rounded so float noise on an exactly flat segment
 * cannot outrank the volume leader. */
const swingOf = (row: SegmentBubble): number =>
	Math.round(Math.abs(row.secondHalf - row.firstHalf));

function axisOf(config: TileConfig | undefined): CubeAxis {
	const value = config?.axis;
	return value === 'device' || value === 'country' ? value : 'channel';
}

function countOf(axis: CubeAxis, n: number): string {
	const [one, many] = AXIS_NOUN[axis];
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * The `compact` rendering. Under ~130px the plot is shorter than its own axis titles and every bubble
 * packs to MIN_RADIUS, so the field has no readable encoding left. Name the mover instead, counted in
 * pageviews so the bar, the number and the ranking are one quantity. Stays clickable for filtering.
 */
function SegmentsCompact({
	rows,
	axis,
	onSelect,
	activeKey,
}: {
	rows: SegmentBubble[];
	axis: CubeAxis;
	onSelect?: (key: string) => void;
	activeKey?: string;
}): ReactElement {
	const first = rows[0];
	if (!first) return <ChartEmpty reason="range" compact />;
	// IMPORTANT: rows arrive sorted by pageviews descending, so a strict `>` leaves a tie with the
	// largest segment — including the all-flat case, where every swing is 0.
	const lead = rows.reduce((best, row) => (swingOf(row) > swingOf(best) ? row : best), first);

	const shifted = swingOf(lead);
	let movement = 0;
	for (const row of rows) movement += swingOf(row);
	const share = movement > 0 ? Math.round((shifted / movement) * 100) : 0;
	const later = lead.secondHalf > lead.firstHalf;
	const tint = shifted === 0 ? 'var(--muted)' : later ? 'var(--pos)' : 'var(--neg)';
	const context =
		shifted > 0
			? `pageviews shifted · ${share}% of all movement across ${countOf(axis, rows.length)}`
			: `no shift across ${countOf(axis, rows.length)}`;
	const description =
		shifted > 0
			? `${formatNumber(shifted)} ${later ? 'more' : 'fewer'} pageviews in the second half of the range than the first, ${share}% of all movement across ${countOf(axis, rows.length)}`
			: `no shift between the halves of the range, largest of ${countOf(axis, rows.length)} by pageviews`;

	const inner = (
		<>
			<span
				aria-hidden="true"
				className="absolute inset-y-0 left-0 rounded-md opacity-25"
				style={{ width: `${share}%`, background: 'var(--d2)' }}
			/>
			<span className="relative min-w-0 truncate font-medium text-[color:var(--ink)] text-xs">
				{lead.label}
			</span>
			<span
				className="relative ml-auto shrink-0 font-semibold text-sm tabular-nums"
				style={{ color: tint }}
			>
				{shifted > 0 ? `${later ? '+' : '−'}${formatNumber(shifted)}` : '0'}
			</span>
		</>
	);

	return (
		<div className="flex h-full min-h-0 flex-col justify-center gap-1">
			{onSelect ? (
				<button
					type="button"
					onClick={() => onSelect(lead.key)}
					aria-pressed={activeKey === lead.key}
					aria-label={`${lead.label}: ${description}`}
					className={cn(
						'relative flex items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left transition hover:bg-[color:rgb(var(--hover))]',
						activeKey === lead.key && 'bg-[color:rgb(var(--hover))]',
					)}
				>
					{inner}
				</button>
			) : (
				<div className="relative flex items-center gap-2 overflow-hidden rounded-md px-2 py-1.5">
					{inner}
				</div>
			)}
			<p className="truncate px-2 text-[10px] text-[color:var(--faint)]">{context}</p>
		</div>
	);
}

function SegmentsBody({
	cells,
	series,
	filter,
	axis,
	density,
	onSelect,
	activeKey,
}: {
	cells: CubeCell[];
	series: SeriesPoint[];
	filter: CubeFilter;
	axis: CubeAxis;
	density: TileDensity;
	onSelect?: (key: string) => void;
	activeKey?: string;
}): ReactElement {
	const split = useMemo(() => rangeSplit(series, cells), [series, cells]);
	const rows = useMemo(
		() => segmentBubbles(cells, filter, axis, split.midpoint, split.bucketMs),
		[cells, filter, axis, split],
	);

	if (rows.length === 0) {
		// ChartEmpty, not EmptyState: the latter draws its own padded card, and a card inside a tile
		// that is already a card does not fit the tile's smallest size and never looked intentional.
		return (
			<ChartEmpty reason="range" title="No segments yet" compact={density === 'compact'}>
				The dimensional cube is empty for this window, so there is nothing to place: this
				chart needs per-bucket counts, not a ranked list.
			</ChartEmpty>
		);
	}

	if (density === 'compact') {
		return (
			<SegmentsCompact rows={rows} axis={axis} onSelect={onSelect} activeKey={activeKey} />
		);
	}

	const expanded = density === 'expanded';
	const drawn = rows.slice(0, expanded ? DRAWN_EXPANDED : DRAWN);
	const field = (
		<BubbleField
			data={drawn}
			valueLabel="pageviews"
			xLabel="events per pageview"
			yLabel="momentum"
			formatX={formatRate}
			formatY={formatMomentum}
			xReference={overallRate(rows)}
			omitted={rows.length - drawn.length}
			onSelect={onSelect}
			activeKey={activeKey}
			caption={`${AXIS_LABEL[axis]} segments: bubble area is pageviews, horizontal position is events per pageview, vertical position is momentum (the shift of the segment's own pageviews from the first half of the range to the second).`}
		/>
	);

	if (!expanded) return field;
	return (
		<div className="flex h-full min-h-0 flex-col gap-1">
			<div className="min-h-0 flex-1">{field}</div>
			<ChartNote>
				Right of the dashed line a segment interacts more than the site average; above the
				solid line it grew across the range.
			</ChartNote>
		</div>
	);
}

export const bubbleBox: TileDef = {
	id: 'segments',
	title: 'Segments',
	// Same reason as the clock: a packed field needs area on both axes, not a wide letterbox.
	size: 'tall',
	expandable: true,
	options: [
		{
			key: 'axis',
			label: 'Dimension',
			type: 'select',
			choices: [
				{ value: 'channel', label: 'Channel' },
				{ value: 'device', label: 'Device' },
				{ value: 'country', label: 'Country' },
			],
			default: 'channel',
		},
	],
	table: (ctx, config) => {
		const axis = axisOf(config);
		const split = rangeSplit(ctx.data.series, ctx.flowCells);
		return {
			columns: [AXIS_LABEL[axis], 'Pageviews', 'Events', 'Events per pageview', 'Momentum'],
			rows: segmentBubbles(
				ctx.flowCells,
				ctx.cubeFilter,
				axis,
				split.midpoint,
				split.bucketMs,
			).map((row) => [
				row.key,
				row.pageviews,
				row.events,
				formatRate(row.x),
				formatMomentum(row.y),
			]),
		};
	},
	render: (ctx, density, config) => {
		const axis = axisOf(config);
		return (
			<SegmentsBody
				cells={ctx.flowCells}
				series={ctx.data.series}
				filter={ctx.cubeFilter}
				axis={axis}
				density={density}
				onSelect={ctx.dimSelect(axis)}
				activeKey={ctx.cubeFilter[axis]}
			/>
		);
	},
};

function midpointOf(points: readonly { t: number }[]): number | null {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		if (point.t < lo) lo = point.t;
		if (point.t > hi) hi = point.t;
	}
	return Number.isFinite(lo) ? (lo + hi) / 2 : null;
}

/** Midpoint of the cube's own bucket span — the split the momentum axis measures across. */
export function cubeMidpoint(cells: readonly CubeCell[]): number {
	return midpointOf(cells) ?? 0;
}

/** Bucket width implied by an evenly spaced series; 0 when there are too few points to infer one. */
function bucketSpan(series: readonly SeriesPoint[]): number {
	const first = series[0];
	const last = series[series.length - 1];
	return first && last && series.length > 1 ? (last.t - first.t) / (series.length - 1) : 0;
}

export interface RangeSplit {
	/** Epoch ms the two halves meet at. */
	midpoint: number;
	/** Bucket width, so a bucket straddling the midpoint can be divided rather than assigned. */
	bucketMs: number;
}

/**
 * Where the QUERY WINDOW divides, which is the split momentum has to be measured across.
 *
 * IMPORTANT: the cube's own extent is the DATA's, not the window's. A site whose traffic starts three
 * days into a fourteen-day range would be halved at its own first bucket, so a segment that arrived on
 * day four and has been flat since reads as strongly rising. `series` is zero-filled over `[start, end)`
 * server-side and shares the cube's interval, so its span IS the window — plus the half bucket by which
 * the last bucket's END exceeds its own start. The cube is the fallback for a response with no series.
 */
export function rangeSplit(series: readonly SeriesPoint[], cells: readonly CubeCell[]): RangeSplit {
	const centre = midpointOf(series);
	const bucketMs = bucketSpan(series);
	if (centre == null) return { midpoint: cubeMidpoint(cells), bucketMs: 0 };
	// IMPORTANT: a one-bucket window holds every cell in that single bucket, so there are no halves to
	// compare. Splitting the bucket at its own centre reads flat, where handing it to one side read
	// +100% for every segment at once.
	if (bucketMs === 0) return { midpoint: centre + 0.5, bucketMs: 1 };
	return { midpoint: centre + bucketMs / 2, bucketMs };
}
