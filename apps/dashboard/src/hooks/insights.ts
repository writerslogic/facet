// React Query hooks for the two "visualization read" endpoints the timing and distribution boxes
// draw from: `GET /api/stats/clock` (the 7 × 24 UTC grid) and `GET /api/stats/distribution` (session
// duration + pages-per-session order statistics).
//
// They live here rather than in `hooks/stats.ts` because neither takes a `StatsQuery`: the clock
// accepts the dimension filters but no `interval`, and the distribution accepts ONLY `channel` — the
// server 400s on `path`/`country`/`device`/`hostname` rather than answering the unfiltered
// distribution under a filtered label. Encoding that asymmetry in the hook signatures is the point:
// a caller cannot accidentally pass a filter the endpoint would reject, and cannot forget that the
// distribution it renders is NOT sliced the way the rest of the board is.

import type { ClockResponse, SessionDistributionResponse } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api.js';
import { siteQueryKey } from '../lib/queryKeys.js';
import type { Range } from '../state.js';

/** The dimension filters `GET /api/stats/clock` honours. Every one is an `events` column. */
export interface ClockFilter {
	country?: string;
	device?: string;
	channel?: string;
}

function rangeParams(siteId: string, range: Range): URLSearchParams {
	return new URLSearchParams({
		site_id: siteId,
		start: String(range.start),
		end: String(range.end),
	});
}

/**
 * The 7 × 24 activity grid. Everything in the response is UTC and stays UTC — any local-time view is
 * the renderer's own shift, done client-side and labelled as such (see `PolarClock`).
 */
export function useClock(apiKey: string, siteId: string, range: Range, filter: ClockFilter = {}) {
	return useQuery({
		queryKey: siteQueryKey('clock', siteId, range, filter),
		queryFn: () => {
			const params = rangeParams(siteId, range);
			if (filter.country) params.set('country', filter.country);
			if (filter.device) params.set('device', filter.device);
			if (filter.channel) params.set('channel', filter.channel);
			return apiFetch<ClockResponse>(`/api/stats/clock?${params}`, apiKey);
		},
		enabled: Boolean(apiKey && siteId) && range.end > range.start,
		// Cross-filtering the board re-reads the same grid; keep the old one on screen for the round
		// trip instead of collapsing the tile to a skeleton. Site-scoped, so a profile switch never
		// shows the previous site's grid under the new label.
		placeholderData: (prev, prevQuery) =>
			prevQuery?.queryKey[1] === siteId ? prev : undefined,
	});
}

/**
 * Session duration + pages-per-session summary statistics.
 *
 * `channel` is the ONLY filter passed on, because it is the only one `event_sessions` carries. The
 * caller is responsible for telling the reader that the other active filters do not apply here —
 * silently rendering the unfiltered distribution beneath a filtered board would be a lie the API
 * deliberately refuses to tell.
 */
export function useSessionDistribution(
	apiKey: string,
	siteId: string,
	range: Range,
	channel?: string,
) {
	return useQuery({
		queryKey: siteQueryKey('distribution', siteId, range, channel ?? null),
		queryFn: () => {
			const params = rangeParams(siteId, range);
			if (channel) params.set('channel', channel);
			return apiFetch<SessionDistributionResponse>(
				`/api/stats/distribution?${params}`,
				apiKey,
			);
		},
		enabled: Boolean(apiKey && siteId) && range.end > range.start,
		placeholderData: (prev, prevQuery) =>
			prevQuery?.queryKey[1] === siteId ? prev : undefined,
	});
}
