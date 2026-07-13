// Shared stats-API types: query parameters and response shapes for GET /api/stats.

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

/** A single point in a time series. */
export interface SeriesPoint {
	/** Bucket start, unix epoch milliseconds. */
	t: number;
	pageviews: number;
	visitors: number;
}

/** Response body for `GET /api/stats`. */
export interface StatsResponse {
	summary: StatsSummary;
	series: SeriesPoint[];
	top_paths: CountRow[];
	top_referrers: CountRow[];
	top_events: CountRow[];
}
