// React Query hook for the stats endpoint. Keyed on the full query so preset/range changes
// refetch automatically; disabled until an API key is present.

import type { Freshness, StatsQuery, StatsResponse } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, qs } from '../api.js';
import type { Range } from '../state.js';

export function useStats(apiKey: string, query: StatsQuery) {
	return useQuery({
		queryKey: ['stats', query],
		queryFn: () => apiFetch<StatsResponse>(`/api/stats?${qs(query)}`, apiKey),
		enabled: Boolean(apiKey),
	});
}

/** Same shape as useStats, but for a comparison window; only runs when `enabled`. */
export function useCompareStats(apiKey: string, query: StatsQuery, enabled: boolean) {
	return useQuery({
		queryKey: ['stats-compare', query],
		queryFn: () => apiFetch<StatsResponse>(`/api/stats?${qs(query)}`, apiKey),
		enabled: Boolean(apiKey) && enabled,
	});
}

/** Session-materialization freshness for a site/range, sourced from the main stats endpoint. */
export function useFreshness(apiKey: string, siteId: string, range: Range) {
	return useQuery({
		queryKey: ['freshness', siteId, range],
		queryFn: async (): Promise<Freshness | null> => {
			const res = await apiFetch<StatsResponse>(
				`/api/stats?${qs({ site_id: siteId, start: range.start, end: range.end })}`,
				apiKey,
			);
			return res.meta ?? null;
		},
		enabled: Boolean(apiKey && siteId),
	});
}
