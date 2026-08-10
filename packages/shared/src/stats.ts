// Shared stats-API types: query parameters and response shapes for GET /api/stats.

import type { BreakdownDimension, QueryIntent } from './schemas.js';

/** Time-bucket granularity for time-series responses. */
export type Interval = 'hour' | 'day';

/** Common filters accepted by read endpoints (as query-string params). */
export interface StatsQuery {
	site_id: string;
	/** Optional hostname filter. */
	hostname?: string;
	/** Inclusive start of range, unix epoch milliseconds. */
	start: number;
	/** Exclusive end of range, unix epoch milliseconds. */
	end: number;
	interval?: Interval;
	/** Optional exact-match dimension filters (server-side; high-cardinality path/referrer live here). */
	path?: string;
	referrer?: string;
	country?: string;
	device?: string;
	channel?: string;
}

/** Internal filter for stats query helpers (camelCase, post-validation). */
export interface StatsFilter {
	siteId: string;
	hostname?: string;
	/** Inclusive start, unix epoch milliseconds. */
	start: number;
	/** Exclusive end, unix epoch milliseconds. */
	end: number;
	/** Optional exact-match dimension filters (undefined = unconstrained). */
	path?: string;
	referrer?: string;
	country?: string;
	device?: string;
	channel?: string;
}

/** Aggregate totals for a site over a range. */
export interface StatsSummary {
	pageviews: number;
	visitors: number;
	events: number;
}

/** A single name/count row (top paths, referrers, custom events). */
export interface CountRow {
	key: string;
	count: number;
}

/** Engagement metrics derived from sessionized events over a range. */
export interface EngagementSummary {
	sessions: number;
	bounce_rate: number;
	pages_per_session: number;
	avg_duration_ms: number;
}

/** A single point in a time series. */
export interface SeriesPoint {
	/** Bucket start, unix epoch milliseconds. */
	t: number;
	pageviews: number;
	visitors: number;
}

/** One cell of the low-cardinality dimensional cube: counts for a (bucket, device, country, channel).
 * Shipped once per range so the client can slice by these axes with zero further server round-trips.
 * High-cardinality dimensions (path, referrer) are intentionally NOT in the cube. */
export interface CubeCell {
	/** Bucket start, unix epoch milliseconds. */
	t: number;
	device: string;
	/** Country folded to the top-N by volume plus `'other'`, so the cube stays bounded and complete. */
	country: string;
	channel: string;
	pageviews: number;
	events: number;
	/** COUNT(DISTINCT visitor) WITHIN this cell. NOT additive across cells — summing over-counts a
	 * visitor who spans multiple cells. Exact only per-cell and for the unfiltered whole-range total. */
	visitors: number;
}

/** The dimensional cube for a range, plus the interval its buckets use. */
export interface CubeResponse {
	interval: Interval;
	cells: CubeCell[];
}

/** A detected anomaly in a metric's hourly series, with an optional root-cause diagnosis. */
export interface Anomaly {
	metric: 'pageviews';
	/** ms bucket start of the anomalous (most recent) hour. */
	bucket: number;
	/** Pageviews in that bucket. */
	value: number;
	baseline_mean: number;
	/** Signed z-score. */
	z: number;
	direction: 'drop' | 'spike';
	diagnosis: {
		dimension: 'device' | 'country' | 'channel';
		value: string;
		current: number;
		baseline_avg: number;
	} | null;
	/** Plain-language autopsy. */
	summary: string;
}

/** Response body for `GET /api/stats/anomalies`. */
export interface AnomaliesResponse {
	anomalies: Anomaly[];
}

/** Result of executing a constrained natural-language query intent over the aggregate helpers. */
export interface NlQueryResult {
	intent: QueryIntent;
	answer: string;
	result:
		| { kind: 'scalar'; value: number }
		| { kind: 'breakdown'; rows: CountRow[] }
		| { kind: 'series'; points: SeriesPoint[] };
	/** True when `intent` is the server's silent default (the model's output could not be parsed or
	 * validated), set only by `answerQuestion`. Absent (not false) when a caller executed an intent it
	 * chose itself, e.g. `runQueryIntent` in isolation — there is no fallback question to answer. */
	fallback?: boolean;
}

/**
 * Freshness metadata for session-derived analytics. Sessions/engagement/channels are materialized
 * from raw events by an hourly cron, so very recent activity may not be reflected yet.
 */
export interface Freshness {
	/** Materialization cadence for session-derived analytics. */
	materialization: 'hourly';
	/** True when raw events exist in the range but no sessions are materialized yet (still pending). */
	pending: boolean;
}

/**
 * Realtime snapshot over a trailing window. `visitors` is the count of distinct daily visitor
 * hashes seen in the window — a privacy-safe proxy for "active visitors" (no cookies, no persistent
 * id). It is an approximation: a visitor is de-duplicated only within the current UTC day.
 */
export interface RealtimeSnapshot {
	/** Trailing window width in milliseconds. */
	window_ms: number;
	/** Distinct visitor hashes seen in the window (active-visitor proxy). */
	visitors: number;
	/** Pageviews in the window. */
	pageviews: number;
	/** End of the window (unix ms) — effectively "as of" time. */
	until: number;
}

/** Cohort period bucket for retention analysis. */
export type CohortPeriod = 'day' | 'week';

/** One cohort row of the retention triangle. */
export interface CohortRow {
	/** Cohort label: the period bucket of first activity (`YYYY-MM-DD` for day, ISO week start
	 * `YYYY-MM-DD` for week). */
	cohort: string;
	/** Distinct visitors whose first activity fell in this cohort period. */
	size: number;
	/** `retention[n]` is the fraction (0..1) of the cohort seen n periods after their first.
	 * `retention[0]` is always 1 (the cohort period itself). */
	retention: number[];
}

/**
 * Cohort-retention triangle. Cohorts are grouped by the period of a visitor's first activity;
 * each subsequent cell is the fraction of that cohort seen n periods later.
 *
 * CAVEAT (salt window): a visitor_hash is stable only WITHIN one salt window (default: daily). At
 * the default daily window the same person gets a NEW hash each day, so cross-period retention is
 * legitimately ~0 — that is honest, not a bug. `note` carries this explanation for the UI.
 */
export interface CohortRetentionResponse {
	period: CohortPeriod;
	cohorts: CohortRow[];
	/** Human-readable salt-window caveat for the UI to surface. */
	note: string;
}

export interface StatsResponse {
	summary: StatsSummary;
	series: SeriesPoint[];
	top_paths: CountRow[];
	top_referrers: CountRow[];
	top_events: CountRow[];
	top_countries: CountRow[];
	top_devices: CountRow[];
	engagement: EngagementSummary;
	channels: CountRow[];
	/** Private-by-construction segmentation breakdowns (k-anonymity floor applied server-side). Optional
	 * for backward compatibility; absent on older responses. */
	top_browsers?: CountRow[];
	top_os?: CountRow[];
	top_screens?: CountRow[];
	top_languages?: CountRow[];
	top_regions?: CountRow[];
	top_networks?: CountRow[];
	top_connections?: CountRow[];
	/** Ecommerce revenue over the range (dominant currency), and per-channel revenue (k-anonymised).
	 * Optional/absent for sites that send no valued events. */
	revenue?: RevenueSummary;
	revenue_by_channel?: CountRow[];
	/** Multi-touch attribution over the range (per-model channel credit). Absent when there are no
	 * converting (valued) paths. */
	attribution?: AttributionResult;
	/** Session-data freshness. Optional for backward compatibility. */
	meta?: Freshness;
}

/** One group of a `GET /api/stats/breakdown` response. `key` is the dimension's value, with an
 * absent one reported as the empty string — the columnar store has no NULL, so both stores fold a
 * missing dimension to `''` rather than each inventing its own label for it. */
export interface BreakdownRow {
	key: string;
	/** All events in the group, pageviews included. */
	events: number;
	pageviews: number;
	/** Distinct visitor hashes within the group. NOT additive across groups, and bounded below by the
	 * k-anonymity floor every group had to clear to appear at all. */
	visitors: number;
}

/**
 * A single-dimension breakdown over the range.
 *
 * Which store answered is part of the response, not an implementation detail: the columnar store
 * SAMPLES at high volume, so `events` and `pageviews` are sampling-corrected estimates and
 * `visitors` — a distinct count, which no sampling weight can correct — is a LOWER bound whenever
 * `sampled` is true. A caller that needs exact figures asks for a range D1 can serve, or reads the
 * fixed top-N lists on `/api/stats`, which are always exact.
 */
export interface BreakdownResponse {
	dimension: BreakdownDimension;
	/** Which store produced these rows. */
	source: 'analytics_engine' | 'd1';
	/** True when the columnar store returned sampled rows, making every figure an estimate. Always
	 * false for `d1`, which scans every row. */
	sampled: boolean;
	rows: BreakdownRow[];
}

// ── Visualization contracts (distribution, per-dimension series, path hierarchy, journeys, clock) ──
//
// These five exist because the cube and the flat top-N lists cannot express the shapes a box plot, a
// multi-line chart, a treemap, a chord diagram and a nightingale need. Every one of them is bounded
// by construction: no response grows with the number of sessions, visitors or distinct URLs, and
// none of them ever emits a per-observation row.

/** The percentile levels a distribution reports, ascending. Enough for a box-and-whisker (p25/p50/
 * p75 plus whiskers) AND to shape a violin/density curve without shipping the raw sample. */
export type DistributionPercentile = 'p05' | 'p10' | 'p25' | 'p50' | 'p75' | 'p90' | 'p95' | 'p99';

/** One histogram bin. `[from, to)`; the final bin is open-ended (`to: null`). Bins partition the
 * metric's entire domain, so `sum(count)` always equals the distribution's `count`. */
export interface DistributionBucket {
	from: number;
	/** Exclusive upper edge, or `null` for the open-ended final bin. */
	to: number | null;
	count: number;
}

/**
 * Summary statistics for one metric over the sessions in range, computed in SQL.
 *
 * `percentiles[p]` is the value at 0-based index `floor(p * (n - 1))` of the ascending sample — the
 * "lower" / nearest-rank order statistic, NOT an interpolated one. It is therefore always a value
 * that some session actually had, is exact integer arithmetic (no float drift), and is reproducible
 * by hand from a sorted list. A renderer that wants interpolated quartiles must interpolate itself.
 */
export interface MetricDistribution {
	min: number;
	max: number;
	mean: number;
	percentiles: Record<DistributionPercentile, number>;
	/** Fixed bin edges (see `DistributionBucket`) — the shape a violin/density plot is drawn from. */
	histogram: DistributionBucket[];
}

/**
 * Response body for `GET /api/stats/distribution`.
 *
 * PRIVACY: raw per-session rows are never returned — they are unbounded and each one is a single
 * visitor's behaviour. Order statistics are only emitted once at least `min_count` sessions match,
 * because below that the percentile vector IS the raw sample re-encoded (with n = 5 and 8
 * percentiles reported, every observation appears). When `suppressed` is true both distributions
 * are `null` and only `count` is returned.
 */
export interface SessionDistributionResponse {
	/** Sessions matching the filter — the n behind every statistic below. */
	count: number;
	/** True when `count < min_count`; both distributions are then `null`. */
	suppressed: boolean;
	/** The anonymity floor `count` must reach for statistics to be emitted. */
	min_count: number;
	/** How `percentiles` are picked. See `MetricDistribution`. */
	percentile_method: 'nearest-rank-lower';
	/** Session duration in milliseconds. `null` when suppressed. */
	duration_ms: MetricDistribution | null;
	/** Pageviews per session. `null` when suppressed. */
	pageviews: MetricDistribution | null;
	/** Session-data freshness, as on the other session-derived reads. */
	meta: Freshness;
}

/** Dimensions a per-key time series can be drawn over. Deliberately the high-cardinality pair
 * (`path`, `referrer`) plus the three cube axes, so one endpoint answers every multi-line chart. */
export type SeriesDimension = 'path' | 'referrer' | 'country' | 'device' | 'channel';

/** One bucket of one key's line.
 *
 * There is NO `visitors` field, and that is deliberate. `COUNT(DISTINCT visitor_hash)` per
 * (key, bucket) is not additive along EITHER axis: a visitor who reads two paths in one hour is
 * counted on both lines, and a visitor active in two hours is counted in both buckets. A multi-line
 * chart invites exactly that summation (stacked areas, "total across series" tooltips), so a
 * visitors field here would be wrong in the most-used reading of the chart. `pageviews` and
 * `events` are plain counts and are additive in both directions — those are the only two safe
 * metrics for this shape. For distinct visitors use `GET /api/stats` (whole range) or the cube's
 * per-cell `visitors` with its own non-additivity caveat. */
export interface DimensionSeriesPoint {
	/** Bucket start, unix epoch milliseconds. */
	t: number;
	pageviews: number;
	events: number;
}

/** One line of the chart: a dimension value and its zero-filled series over the range. */
export interface DimensionSeries {
	key: string;
	/** Pageviews for this key over the WHOLE range — the metric the top-N ranking used. */
	total: number;
	/** One point per bucket in [start, end), ascending, empty buckets zero-filled. */
	points: DimensionSeriesPoint[];
}

/** Response body for `GET /api/stats/timeseries`. The series are the top `limit` keys by pageviews;
 * the long tail is omitted, so the lines do NOT sum to the range total (`GET /api/stats` has that).
 * `truncated` says whether anything was left out. */
export interface DimensionSeriesResponse {
	dimension: SeriesDimension;
	interval: Interval;
	series: DimensionSeries[];
	/** True when more keys existed than were returned. */
	truncated: boolean;
}

/**
 * One node of the URL-prefix tree. `pageviews` is the subtree total (what a treemap's area and a
 * sunburst's arc encode); `self` is the pageviews on this exact path, so `pageviews - self` is what
 * the children hold and a node can be drawn with its own slice.
 */
export interface PathTreeNode {
	/** Full prefix, e.g. `/blog` or `/blog/2026`. The root is `/`. */
	path: string;
	/** The single segment this node adds (`blog`). Empty at the root. */
	segment: string;
	/** 0 at the root. */
	depth: number;
	/** Pageviews on this path and everything beneath it. */
	pageviews: number;
	/** Pageviews on this exact path only. */
	self: number;
	children: PathTreeNode[];
	/** Present and true on the synthetic node a parent's folded-away children were rolled into
	 * (long tail, or a subtree below the anonymity floor). Its `path` is not a real URL. */
	other?: boolean;
}

/** Response body for `GET /api/stats/path-tree`. */
export interface PathTreeResponse {
	/** Depth at which the tree stops. A deeper URL contributes to its ancestor at this depth. */
	max_depth: number;
	/** The anonymity floor a node must reach to be labelled; below it a subtree folds into `other`. */
	min_count: number;
	root: PathTreeNode;
	/** Distinct paths that contributed to the tree. */
	paths: number;
	/** True when the site had more distinct paths than the query would read. */
	truncated: boolean;
}

/** One entry→exit journey and how many sessions took it. `entry === exit` is a real single-page
 * journey (a bounce), not a placeholder. */
export interface JourneyPair {
	entry: string;
	exit: string;
	sessions: number;
}

/**
 * Response body for `GET /api/stats/journeys`.
 *
 * PRIVACY: an (entry, exit) pair is a two-step behavioural sequence for one visit, over two
 * attacker-supplied URLs — the most re-identifying shape in this file. A pair is therefore only
 * returned once at least `min_visitors` DISTINCT visitors took it (not merely distinct sessions:
 * one person reloading three times must not clear the floor). `sessions` covers only the returned
 * pairs, so `total_sessions - sessions` is what the floor and the top-N bound withheld.
 */
export interface JourneysResponse {
	pairs: JourneyPair[];
	/** Distinct visitors a pair needs before it is surfaced. */
	min_visitors: number;
	/** Sessions accounted for by `pairs`. */
	sessions: number;
	/** All sessions in range, whether or not their pair was surfaced. */
	total_sessions: number;
	meta: Freshness;
}

/** One cell of the day-of-week × hour-of-day grid. Both coordinates are UTC. */
export interface ClockCell {
	/** UTC day of week, 0 = Sunday … 6 = Saturday. */
	day: number;
	/** UTC hour of day, 0..23. */
	hour: number;
	pageviews: number;
	events: number;
}

/**
 * Response body for `GET /api/stats/clock`: activity folded onto a 7 × 24 grid.
 *
 * TIMEZONE: everything is UTC, always. `events.created_at` is stored as a unix timestamp and the
 * hour/day are derived from it by integer arithmetic on the epoch — no site timezone, no server
 * locale, no `strftime` with a modifier. A dashboard that wants local hours must shift these
 * client-side; the server will not guess a timezone it was never told.
 */
export interface ClockResponse {
	timezone: 'UTC';
	/** Exactly 168 cells (7 × 24), zero-filled, ordered by day then hour. */
	cells: ClockCell[];
	/** Pageviews per UTC hour, index 0..23 — the nightingale's radial marginal. */
	by_hour: number[];
	/** Pageviews per UTC weekday, index 0..6 (Sunday first). */
	by_day: number[];
}

/** Ecommerce revenue rollup for a range. `total`/`aov` are in `currency` (the dominant one when a site
 * mixes currencies); `orders` is the count of valued events. */
export interface RevenueSummary {
	total: number;
	orders: number;
	aov: number;
	currency: string | null;
}

/** Multi-touch attribution models. Heuristics (first/last/linear/position/time_decay) plus the
 * data-driven `markov` (removal-effect over the channel-transition graph). All computed over aggregate,
 * day-scoped channel paths — NO persistent cross-session identity. */
export type AttributionModel = 'first' | 'last' | 'linear' | 'position' | 'time_decay' | 'markov';

/** Per-model channel credit (`count` carries the attributed revenue), plus the converting-path totals.
 * `models[m]` is the channel→revenue ranking under model `m`. */
export interface AttributionResult {
	conversions: number;
	revenue: number;
	models: Record<AttributionModel, CountRow[]>;
}
