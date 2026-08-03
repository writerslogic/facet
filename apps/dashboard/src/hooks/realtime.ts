// Realtime data hooks: the trailing-window snapshot, the live breakdowns over that same window, and
// a cheap "has this site reported at all lately?" probe used only to tell the two empty states apart.
// Auto-refresh pauses while the page is hidden (via useVisible) so a backgrounded tab stops hammering
// the endpoint, and can also be paused explicitly so a number you are reading stops moving under you.

import type { RealtimeSnapshot, StatsQuery, StatsResponse, StatsSummary } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { apiFetch, qs } from '../api.js';
import { EMPTY_SEGMENT, type Segment, segmentParams } from '../lib/segment.js';
import { useStats } from './stats.js';

/** Poll cadence for the snapshot. Exported so the view can render a countdown that is actually true. */
export const REFETCH_MS = 15_000;

const HOUR_MS = 60 * 60 * 1000;
/** Lookback for the "is anything arriving at all?" probe behind the empty state. */
const RECENT_MS = 24 * HOUR_MS;

/** Subscribe to page visibility. Returns true when the document is visible (or unknowable). */
export function useVisible(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			document.addEventListener('visibilitychange', onChange);
			return () => document.removeEventListener('visibilitychange', onChange);
		},
		() => document.visibilityState !== 'hidden',
		() => true,
	);
}

/** The snapshot poll. `paused` is the user's explicit hold; visibility is the automatic one. */
export function useRealtime(apiKey: string, siteId: string, paused = false) {
	const visible = useVisible();
	const live = visible && !paused;
	return useQuery({
		queryKey: ['realtime', siteId],
		queryFn: () => apiFetch<RealtimeSnapshot>(`/api/stats/realtime?site_id=${siteId}`, apiKey),
		enabled: Boolean(apiKey && siteId) && live,
		refetchInterval: live ? REFETCH_MS : false,
	});
}

/**
 * Live breakdowns for the same trailing window as the snapshot, from the standard stats endpoint.
 *
 * This is `useStats` with a readiness gate, not a second implementation of it. Before the first
 * snapshot lands there is no window yet, and `start=0&end=0` is rejected by the server with
 * `bad_range` (400) — so the range itself is passed as the hook's `enabled`.
 *
 * The window is bucketed to the minute upstream, so the query key rolls once a minute; `useStats`'s
 * site-scoped `placeholderData` is what carries the previous rows across that roll instead of
 * blanking all four lists to a skeleton every 60s.
 *
 * `segment` is forwarded verbatim. Unlike the snapshot endpoint next door, `/api/stats` really does
 * narrow on all five dimensions (toStatsFilter → buildFilteredEventWhere), so these four lists are
 * the one part of the Realtime tab that can honour an active segment — and they do.
 */
export function useRealtimeBreakdown(
	apiKey: string,
	siteId: string,
	start: number,
	end: number,
	enabled = true,
	segment: Segment = EMPTY_SEGMENT,
) {
	const query: StatsQuery = {
		site_id: siteId,
		start,
		end,
		interval: 'hour',
		...segmentParams(segment),
	};
	return useStats(apiKey, query, Boolean(siteId) && end > start && enabled);
}

/**
 * 24h summary used only to distinguish "quiet right now" from "nothing is arriving at all". Runs
 * solely while the realtime window is empty, and its key is bucketed to the hour so an idle tab
 * costs one request an hour rather than one per poll. The range end is read at fetch time (not in
 * the key) so the request never carries a future timestamp.
 */
export function useRecentActivity(apiKey: string, siteId: string, enabled: boolean) {
	const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
	return useQuery({
		queryKey: ['realtime-recent', siteId, bucket],
		queryFn: async (): Promise<StatsSummary> => {
			const end = Date.now();
			const res = await apiFetch<StatsResponse>(
				`/api/stats?${qs({
					site_id: siteId,
					start: end - RECENT_MS,
					end,
					interval: 'hour',
				})}`,
				apiKey,
			);
			return res.summary;
		},
		enabled: Boolean(apiKey && siteId) && enabled,
		staleTime: HOUR_MS,
	});
}
