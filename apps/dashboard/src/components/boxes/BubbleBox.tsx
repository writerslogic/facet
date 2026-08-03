// Segments box: the packed bubble field over one cube axis (channel, device or country).
//
// The three quantities the field encodes all come from the cube the board already holds, and all
// three are additive counts, so every rate below is exact rather than an estimate:
//
//   area — pageviews. The volume the ranked lists already show, kept as the size channel so a reader
//          coming from the Channels list recognises the same shape.
//   x    — events per pageview. Interaction intensity. A ranked list cannot show this at all: it is
//          a ratio of two totals, and sorting by either one hides it.
//   y    — momentum, `(second half − first half) / total` of that segment's OWN pageviews across the
//          range. Bounded to [−1, +1], so a small segment doubling and a large one doubling land at
//          the same height — which is the point: the axis is about direction, not size.
//
// `visitors` is deliberately unused. The cube documents it as non-additive across cells, so
// "pages per visitor" computed by summing cells would be quietly biased; pageviews and events are
// plain counts and are additive on both axes.

import type { CubeCell } from '@facet/shared';
import { type ReactElement, useMemo } from 'react';
import type { CubeAxis, CubeFilter } from '../../lib/cube.js';
import { type BubbleDatum, BubbleField } from '../charts/Bubble.js';
import { ChartEmpty } from '../charts/ChartChrome.js';
import type { TileConfig, TileDef } from './types.js';

/** How many bubbles the field draws. The rest stay in the sr-only table and the footnote count. */
const DRAWN = 14;

const AXIS_LABEL: Record<CubeAxis, string> = {
	channel: 'Channel',
	device: 'Device',
	country: 'Country',
};

export interface SegmentBubble extends BubbleDatum {
	pageviews: number;
	events: number;
	firstHalf: number;
	secondHalf: number;
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
		if (cell.t < midpoint) acc.first += cell.pageviews;
		else acc.second += cell.pageviews;
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

function axisOf(config: TileConfig | undefined): CubeAxis {
	const value = config?.axis;
	return value === 'device' || value === 'country' ? value : 'channel';
}

function SegmentsBody({
	cells,
	filter,
	axis,
	onSelect,
	activeKey,
}: {
	cells: CubeCell[];
	filter: CubeFilter;
	axis: CubeAxis;
	onSelect?: (key: string) => void;
	activeKey?: string;
}): ReactElement {
	// The split the momentum axis measures across is the cube's own bucket span, so the chart and the
	// "view as table" read cannot disagree about which half a bucket fell in.
	const midpoint = useMemo(() => cubeMidpoint(cells), [cells]);
	const rows = useMemo(
		() => segmentBubbles(cells, filter, axis, midpoint),
		[cells, filter, axis, midpoint],
	);

	if (rows.length === 0) {
		// ChartEmpty, not EmptyState: the latter draws its own padded card, and a card inside a tile
		// that is already a card does not fit the tile's smallest size and never looked intentional.
		return (
			<ChartEmpty reason="range" title="No segments yet">
				The dimensional cube is empty for this window, so there is nothing to place: this
				chart needs per-bucket counts, not a ranked list.
			</ChartEmpty>
		);
	}

	const drawn = rows.slice(0, DRAWN);
	return (
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
	// `table` is not handed the per-instance config, so it cannot know which axis this slot is
	// showing. Rather than guess one and label the other two's numbers wrongly, it emits all three
	// with a Dimension column — a superset of whatever the chart is drawing, never a mismatch.
	table: (ctx) => {
		const midpoint = cubeMidpoint(ctx.flowCells);
		const rows: (string | number)[][] = [];
		for (const axis of ['channel', 'device', 'country'] as const) {
			for (const row of segmentBubbles(ctx.flowCells, ctx.cubeFilter, axis, midpoint)) {
				rows.push([
					AXIS_LABEL[axis],
					row.key,
					row.pageviews,
					row.events,
					formatRate(row.x),
					formatMomentum(row.y),
				]);
			}
		}
		return {
			columns: [
				'Dimension',
				'Value',
				'Pageviews',
				'Events',
				'Events per pageview',
				'Momentum',
			],
			rows,
		};
	},
	render: (ctx, _expanded, config) => {
		const axis = axisOf(config);
		return (
			<SegmentsBody
				cells={ctx.flowCells}
				filter={ctx.cubeFilter}
				axis={axis}
				onSelect={ctx.dimSelect(axis)}
				activeKey={ctx.cubeFilter[axis]}
			/>
		);
	},
};

/** Midpoint of the cube's own bucket span — the split the momentum axis measures across. */
export function cubeMidpoint(cells: readonly CubeCell[]): number {
	if (cells.length === 0) return 0;
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const cell of cells) {
		if (cell.t < lo) lo = cell.t;
		if (cell.t > hi) hi = cell.t;
	}
	return (lo + hi) / 2;
}
