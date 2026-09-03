// Realtime data hooks: the trailing-window snapshot, the live breakdowns over that same window, and
// a cheap "has this site reported at all lately?" probe used only to tell the two empty states apart.
// Auto-refresh pauses while the page is hidden (via useVisible) so a backgrounded tab stops hammering
// the endpoint, and can also be paused explicitly so a number you are reading stops moving under you.

import type {
	RealtimeContextResponse,
	RealtimeSnapshot,
	StatsQuery,
	StatsSummary,
	StatsSummaryResponse,
} from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { apiFetch, qs } from '../api.js';
import { siteQueryKey } from '../lib/queryKeys.js';
import { EMPTY_SEGMENT, type Segment, segmentParams } from '../lib/segment.js';

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
		queryKey: siteQueryKey('realtime', siteId),
		queryFn: () => apiFetch<RealtimeSnapshot>(`/api/stats/realtime?site_id=${siteId}`, apiKey),
		enabled: Boolean(siteId) && live,
		refetchInterval: live ? REFETCH_MS : false,
		// Keep trying after a transient edge/network failure; the view also exposes an immediate retry.
		// TanStack bounds the retry sequence, while the poll interval provides automatic recovery after
		// that sequence is exhausted.
		retry: 3,
		retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, REFETCH_MS),
		refetchOnReconnect: true,
	});
}

/**
 * Live breakdowns for the same trailing window as the snapshot, from the narrow context endpoint.
 *
 * Before the first snapshot lands there is no window yet, and `start=0&end=0` is rejected by the
 * server with `bad_range` (400), so the range itself is part of the hook's readiness gate.
 *
 * The window is bucketed to the minute upstream, so the query key rolls once a minute; site-scoped
 * placeholder data carries the previous rows across that roll instead of blanking the lists.
 *
 * `segment` is forwarded verbatim. Unlike the snapshot endpoint next door, the context read narrows
 * its event-backed lists through the standard stats filter.
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
	return useQuery({
		queryKey: siteQueryKey('realtime-context', siteId, query),
		queryFn: () =>
			apiFetch<RealtimeContextResponse>(`/api/stats/realtime-context?${qs(query)}`, apiKey),
		enabled: Boolean(siteId) && end > start && enabled,
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === siteId ? previous : undefined,
	});
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
		queryKey: siteQueryKey('realtime-recent', siteId, bucket),
		queryFn: async (): Promise<StatsSummary> => {
			const end = Date.now();
			const res = await apiFetch<StatsSummaryResponse>(
				`/api/stats/summary?${qs({
					site_id: siteId,
					start: end - RECENT_MS,
					end,
					interval: 'hour',
				})}`,
				apiKey,
			);
			return res.summary;
		},
		enabled: Boolean(siteId) && enabled,
		staleTime: HOUR_MS,
	});
}
