// Shared stats-API types: query parameters and response shapes for GET /api/stats.

import type { QueryIntent } from './schemas.js';

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
}

/** Internal filter for stats query helpers (camelCase, post-validation). */
export interface StatsFilter {
	siteId: string;
	hostname?: string;
	/** Inclusive start, unix epoch milliseconds. */
	start: number;
	/** Exclusive end, unix epoch milliseconds. */
	end: number;
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
	/** Session-data freshness. Optional for backward compatibility. */
	meta?: Freshness;
}
