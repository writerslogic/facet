// Per-dimension time series: the read, the categorical palette, and the pure geometry that both
// temporal charts (MultiLine, BrushRange) share.
//
// WHY ONE MODULE: the two charts draw the same data with the same hues and the same bucket→pixel
// arithmetic. Splitting that between them is how two charts on one board end up disagreeing about
// which key is "the blue one", or about which bucket the crosshair is pointing at. Everything here
// is a pure function of its arguments (except the one query hook at the bottom) so the maths is
// testable without a canvas — jsdom has none, and uPlot degrades to an empty container under it.
//
// There is deliberately NO visitors metric. `/api/stats/timeseries` does not return one because a
// per-(key, bucket) distinct-visitor count is non-additive along BOTH axes, and a multi-line chart
// invites exactly the summation that would be wrong. `pageviews` and `events` are plain counts.

import type {
	DimensionSeries,
	DimensionSeriesResponse,
	Interval,
	SeriesDimension,
} from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, qs } from '../api.js';
import { formatDateTime, formatDayShort } from '../lib/datetime.js';
import { segmentParams } from '../lib/segment.js';
import { useDashboard } from '../state.js';
import { useSegment } from './segment.js';

/** The two additive metrics a line can plot. See the module header for why `visitors` is absent. */
export type SeriesMetric = 'pageviews' | 'events';

export const METRIC_LABEL: Record<SeriesMetric, string> = {
	pageviews: 'Pageviews',
	events: 'Events',
};

// ---------------------------------------------------------------------------
// Palette

/**
 * The order the categorical hues are handed out in, as 0-based indices into `--c1..--c6`
 * (i.e. `--c3, --c5, --c6, --c1, --c4, --c2`).
 *
 * NOT `--c1..--c6` in declaration order. Adjacent lines are the pairs a reader most often has to
 * tell apart, and in declaration order the worst adjacent pair across the five palettes is Prism's
 * `--c1`/`--c2` (#6d5efc vs #9b5bff) at ΔE_OKLab 0.074 — indigo beside indigo. This permutation was
 * chosen by exhaustively scoring all 720 orderings on the minimum adjacent ΔE over all five
 * palettes at the worst case of 8 lines (the cycle wraps at 6); it lifts that floor to 0.124, in
 * the muted "Deep FinTech" palette, which is the palette's own limit rather than an ordering
 * mistake. Re-run that scoring if the palettes change.
 */
export const HUE_ORDER = [2, 4, 5, 0, 3, 1] as const;

/** The CSS token for line `i` — for SVG/DOM chrome (legend swatches, focus rings). */
export function hueVar(i: number): string {
	return `var(--c${(HUE_ORDER[i % HUE_ORDER.length] ?? 0) + 1})`;
}

/** The concrete colour for line `i`, resolved from `useThemeColors().cat` (canvas cannot read vars). */
export function hueOf(cat: readonly string[], i: number): string {
	const index = HUE_ORDER[i % HUE_ORDER.length] ?? 0;
	return cat[index] ?? cat[0] ?? '#6d5efc';
}

/**
 * A second, non-colour encoding per line. Colour alone must never be the only key — the muted
 * palette's six hues sit inside ΔE 0.21 of each other, and ~8% of readers cannot use hue at all.
 * The legend swatch draws the same pattern the line does, so the two are matched by shape as well
 * as by colour. Index 0 is solid so the top-ranked line stays the cleanest to read.
 */
export const SERIES_DASHES: readonly (readonly number[] | undefined)[] = [
	undefined,
	[7, 4],
	[2, 3],
	[11, 4, 2, 4],
	[4, 3, 1, 3],
	[14, 5],
	[1, 3],
	[9, 4, 4, 4],
];

export function dashOf(i: number): number[] | undefined {
	const dash = SERIES_DASHES[i % SERIES_DASHES.length];
	return dash ? [...dash] : undefined;
}

// ---------------------------------------------------------------------------
// Bucket geometry

/**
 * The shared x-axis, in unix ms. Every line is zero-filled across every bucket upstream, so they
 * are already aligned; the longest one is taken rather than the first purely so a short/absent
 * series can never silently truncate the axis for the others.
 */
export function bucketTimes(series: readonly DimensionSeries[]): number[] {
	let longest: DimensionSeries | undefined;
	for (const s of series) {
		if (!longest || s.points.length > longest.points.length) longest = s;
	}
	return (longest?.points ?? []).map((p) => p.t);
}

/**
 * The series a chart is allowed to draw.
 *
 * Every reader below indexes `points` directly, so a response carrying a series without one throws
 * during render — and an uncaught throw in a React render unmounts the WHOLE dashboard, not the one
 * tile that asked for it. A blank page is a far worse answer to a malformed payload than a chart that
 * says it has nothing to show, so the response is filtered once, where it enters the UI, rather than
 * defended against in five separate array reads.
 */
export function drawableSeries(series: readonly DimensionSeries[] | undefined): DimensionSeries[] {
	if (!Array.isArray(series)) return [];
	return series.filter((s): s is DimensionSeries => Boolean(s) && Array.isArray(s.points));
}

/**
 * One line's values, aligned to `length` buckets. A missing bucket becomes `null`, not 0: a gap is
 * "we have no point here", and drawing it as zero would invent a trough the data never had.
 */
export function valuesOf(
	series: DimensionSeries,
	metric: SeriesMetric,
	length: number,
): (number | null)[] {
	const out: (number | null)[] = new Array(length).fill(null);
	for (let i = 0; i < series.points.length && i < length; i++) {
		out[i] = series.points[i]?.[metric] ?? null;
	}
	return out;
}

/** An inclusive bucket-index window `[from, to]`. Indices, not timestamps: the brush drags in
 * buckets, and a bucket is the smallest thing the data can actually distinguish. */
export interface BucketWindow {
	from: number;
	to: number;
}

/** Fewer than three buckets is a line with nothing to say; the brush stops there. */
export const MIN_WINDOW_BUCKETS = 3;

export function fullWindow(count: number): BucketWindow {
	return { from: 0, to: Math.max(0, count - 1) };
}

export function isFullWindow(w: BucketWindow, count: number): boolean {
	return w.from <= 0 && w.to >= count - 1;
}

/** Order, integerise and clamp a window into `[0, count-1]`, never narrower than the minimum span.
 * Every mutation below funnels through here so no path can produce an inverted or off-axis window. */
export function clampWindow(
	w: BucketWindow,
	count: number,
	minSpan = MIN_WINDOW_BUCKETS,
): BucketWindow {
	if (count <= 0) return { from: 0, to: 0 };
	const span = Math.max(1, Math.min(minSpan, count));
	let from = Math.round(Math.min(w.from, w.to));
	let to = Math.round(Math.max(w.from, w.to));
	from = Math.max(0, Math.min(from, count - 1));
	to = Math.max(0, Math.min(to, count - 1));
	if (to - from + 1 < span) {
		to = from + span - 1;
		if (to > count - 1) {
			to = count - 1;
			from = Math.max(0, to - span + 1);
		}
	}
	return { from, to };
}

/** Pixel x → bucket index, for a track `width` px wide holding `count` buckets. */
export function indexAtX(x: number, width: number, count: number): number {
	if (count <= 1 || width <= 0) return 0;
	const ratio = x / width;
	return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
}

/** Bucket index → the pixel x of its centre on a `width`-wide track. */
export function xAtIndex(index: number, width: number, count: number): number {
	if (count <= 1 || width <= 0) return 0;
	return (index / (count - 1)) * width;
}

/** The window described by a drag between two pixel positions. */
export function windowFromPixels(
	x0: number,
	x1: number,
	width: number,
	count: number,
): BucketWindow {
	return clampWindow({ from: indexAtX(x0, width, count), to: indexAtX(x1, width, count) }, count);
}

/** The brush rectangle for a window: `left`/`width` in px on a `width`-wide track. Half a bucket of
 * bleed on each side so the rect covers the buckets it selects rather than their centre points. */
export function windowToPixels(
	w: BucketWindow,
	width: number,
	count: number,
): { left: number; width: number } {
	if (count <= 1 || width <= 0) return { left: 0, width };
	const half = width / (count - 1) / 2;
	const left = Math.max(0, xAtIndex(w.from, width, count) - half);
	const right = Math.min(width, xAtIndex(w.to, width, count) + half);
	return { left, width: Math.max(1, right - left) };
}

/** Slide the whole window by `delta` buckets, keeping its span (the keyboard's ←/→). Stops at the
 * ends rather than shrinking: an arrow key must never silently change how much you are looking at. */
export function moveWindow(w: BucketWindow, delta: number, count: number): BucketWindow {
	const span = w.to - w.from;
	let from = w.from + delta;
	from = Math.max(0, Math.min(from, count - 1 - span));
	return clampWindow({ from, to: from + span }, count);
}

/**
 * Move one edge by `delta` buckets; the other edge stays exactly where it is.
 *
 * The moving edge is stopped against the fixed one BEFORE clamping, because `clampWindow` orders
 * its inputs: dragging the end handle past the start would otherwise silently swap the two and turn
 * a collapse into a mirrored window jumping off to the other side of the chart.
 */
export function resizeWindow(
	w: BucketWindow,
	edge: 'start' | 'end',
	delta: number,
	count: number,
): BucketWindow {
	const span = Math.max(1, Math.min(MIN_WINDOW_BUCKETS, count)) - 1;
	if (edge === 'start') {
		return clampWindow({ from: Math.min(w.from + delta, w.to - span), to: w.to }, count);
	}
	return clampWindow({ from: w.from, to: Math.max(w.to + delta, w.from + span) }, count);
}

/** Put one edge ON `index` (the pointer's edge handles, and Home/End). */
export function setEdge(
	w: BucketWindow,
	edge: 'start' | 'end',
	index: number,
	count: number,
): BucketWindow {
	return resizeWindow(w, edge, index - (edge === 'start' ? w.from : w.to), count);
}

/** A sensible arrow-key step: 1 bucket for a short range, ~1% of the axis for a long one, so
 * crossing 2160 hourly buckets does not take 2160 key presses. */
export function keyStep(count: number, coarse = false): number {
	const base = Math.max(1, Math.round(count / 100));
	return coarse ? Math.max(base * 10, 10) : base;
}

// ---------------------------------------------------------------------------
// Readouts

/** Largest value across every line inside `[from, to]` — the y-domain a window zoom rescales to. */
export function windowMax(
	series: readonly DimensionSeries[],
	metric: SeriesMetric,
	from: number,
	to: number,
): number {
	let max = 0;
	for (const s of series) {
		for (let i = Math.max(0, from); i <= to && i < s.points.length; i++) {
			const v = s.points[i]?.[metric] ?? 0;
			if (v > max) max = v;
		}
	}
	return max;
}

/** One line's summary inside a window: its total there, its share of all shown lines' total, and
 * where it peaked. `share` is a share of the LINES SHOWN, never of site traffic — the endpoint
 * returns the top N keys and drops the tail, so these do not sum to the range total. */
export interface SeriesSummary {
	key: string;
	total: number;
	share: number;
	peak: number;
	peakIndex: number;
}

export function summarize(
	series: readonly DimensionSeries[],
	metric: SeriesMetric,
	from: number,
	to: number,
): SeriesSummary[] {
	const rows = series.map((s) => {
		let total = 0;
		let peak = 0;
		let peakIndex = Math.max(0, from);
		for (let i = Math.max(0, from); i <= to && i < s.points.length; i++) {
			const v = s.points[i]?.[metric] ?? 0;
			total += v;
			if (v > peak) {
				peak = v;
				peakIndex = i;
			}
		}
		return { key: s.key, total, peak, peakIndex, share: 0 };
	});
	const grand = rows.reduce((sum, r) => sum + r.total, 0);
	return rows.map((r) => ({ ...r, share: grand > 0 ? r.total / grand : 0 }));
}

/** Format a bucket start for a label, in the clock the dashboard is currently showing. Routed through
 * lib/datetime so the header's Times toggle moves this label too: a bucket label left on a different
 * clock from the axis above it is exactly the drift that is only noticed during an incident. */
export function formatBucket(t: number, interval: Interval): string {
	return interval === 'hour' ? formatDateTime(t) : formatDayShort(t);
}

/** "Mar 3 – Mar 9 UTC · 168 buckets" — the brush's spoken value, for `aria-valuetext`. */
export function windowLabel(times: readonly number[], w: BucketWindow, interval: Interval): string {
	const start = times[w.from];
	const end = times[w.to];
	if (start === undefined || end === undefined) return 'whole range';
	const span = w.to - w.from + 1;
	const unit = interval === 'hour' ? 'hour' : 'day';
	return `${formatBucket(start, interval)} to ${formatBucket(end, interval)} UTC, ${span} ${unit}${span === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// The read

export interface DimensionSeriesOptions {
	dimension: SeriesDimension;
	/** 1–8; the server rejects anything outside that rather than clamping. */
	limit?: number;
	enabled?: boolean;
}

/**
 * `GET /api/stats/timeseries` for the active site, range and SEGMENT.
 *
 * The board slices device/country/channel client-side from the cube and only sends path/referrer to
 * the server; there is no cube for this endpoint, so all five dimensions travel with every request.
 * The endpoint applies the same `toStatsFilter` as `GET /api/stats` (apps/server/src/routes/stats.ts),
 * so the segment is honoured in full — nothing here is silently dropped.
 */
export function useDimensionSeries({
	dimension,
	limit = 5,
	enabled = true,
}: DimensionSeriesOptions) {
	const { apiKey, siteId, preset, range } = useDashboard();
	const { segment } = useSegment();
	const interval: Interval = preset === '24h' ? 'hour' : 'day';
	const params = segmentParams(segment);
	const query = {
		site_id: siteId,
		start: range.start,
		end: range.end,
		interval,
		...params,
	};

	return useQuery({
		queryKey: ['timeseries', dimension, limit, query],
		queryFn: () =>
			apiFetch<DimensionSeriesResponse>(
				`/api/stats/timeseries?${qs(query)}&dimension=${encodeURIComponent(dimension)}&limit=${limit}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId) && enabled && range.end > range.start,
		staleTime: 60_000,
		// Hold the previous answer while the next one loads so a range/segment change re-scales the
		// chart instead of collapsing it to a skeleton. Scoped to the same site: a site switch must
		// not draw the previous site's lines under the new site's label.
		placeholderData: (prev, prevQuery) =>
			(prevQuery?.queryKey[3] as { site_id?: string } | undefined)?.site_id === siteId
				? prev
				: undefined,
	});
}
