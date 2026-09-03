import type { StatsFilter, StatsQueryInput } from '@facet/shared';
import { DAY_MS, HOUR_MS, MAX_RANGE_DAYS } from '../../lib/constants.js';
import { ApiError } from '../../lib/http.js';

/** Reject an empty range or one exceeding the maximum queryable span. */
export function assertStatsRange(start: number, end: number): void {
	if (end <= start) {
		throw new ApiError('bad_range', 400);
	}
	if (end - start > MAX_RANGE_DAYS * DAY_MS) {
		throw new ApiError('range_too_large', 400);
	}
}

/** Resolve the shared time-bucket granularity for one validated stats query. */
export function statsInterval(query: StatsQueryInput): 'hour' | 'day' {
	return query.interval ?? (query.end - query.start <= 48 * HOUR_MS ? 'hour' : 'day');
}

/** Validate a stats query against the authenticated site and return the internal filter. */
export function statsFilter(query: StatsQueryInput, siteId: string): StatsFilter {
	if (query.site_id !== siteId) {
		throw new ApiError('site_mismatch', 403);
	}
	assertStatsRange(query.start, query.end);
	return {
		siteId: query.site_id,
		hostname: query.hostname,
		start: query.start,
		end: query.end,
		path: query.path,
		referrer: query.referrer,
		country: query.country,
		device: query.device,
		channel: query.channel,
	};
}
