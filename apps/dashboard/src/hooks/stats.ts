// React Query hook for the stats endpoint. Keyed on the full query so preset/range changes
// refetch automatically; disabled until an API key is present.

import type { Freshness, StatsQuery, StatsResponse } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, qs } from '../api.js';
import { siteQueryKey } from '../lib/queryKeys.js';
import type { Range } from '../state.js';

/**
 * The stats read. `enabled` is the caller's own gate, ANDed with the API key.
 *
 * It exists because the key alone is not enough to know the request is sendable: a caller whose
 * window is derived from another response (the Realtime tab's trailing window, say) has no range on
 * first render, and `start=0&end=0` is rejected by the server's `assertRange` with a 400 `bad_range`.
 * Such a caller passes its own readiness here rather than forking a private copy of this hook.
 */
export function useStats(apiKey: string, query: StatsQuery, enabled = true) {
	return useQuery({
		queryKey: siteQueryKey('stats', query.site_id, query),
		queryFn: () => apiFetch<StatsResponse>(`/api/stats?${qs(query)}`, apiKey),
		enabled: Boolean(apiKey) && enabled,
		// Keep the prior data on screen while the next query loads so a range/filter change never drops
		// back to the BentoSkeleton (isLoading stays false; isPlaceholderData flags the swap). Scoped to
		// the same site: switching sites must NOT flash the previous site's numbers under the new label,
		// so a cross-site swap falls through to undefined → skeleton.
		placeholderData: (prev, prevQuery) =>
			prevQuery?.queryKey[1] === query.site_id ? prev : undefined,
	});
}

/** Same shape as useStats, but for a comparison window; only runs when `enabled`. */
export function useCompareStats(apiKey: string, query: StatsQuery, enabled: boolean) {
	return useQuery({
		queryKey: siteQueryKey('stats-compare', query.site_id, query),
		queryFn: () => apiFetch<StatsResponse>(`/api/stats?${qs(query)}`, apiKey),
		enabled: Boolean(apiKey) && enabled,
	});
}

/** Session-materialization freshness for a site/range, sourced from the main stats endpoint. */
export function useFreshness(apiKey: string, siteId: string, range: Range, enabled = true) {
	return useQuery({
		queryKey: siteQueryKey('freshness', siteId, range),
		queryFn: async (): Promise<Freshness | null> => {
			const res = await apiFetch<StatsResponse>(
				`/api/stats?${qs({ site_id: siteId, start: range.start, end: range.end })}`,
				apiKey,
			);
			return res.meta ?? null;
		},
		enabled: Boolean(apiKey && siteId) && enabled && range.end > range.start,
	});
}
