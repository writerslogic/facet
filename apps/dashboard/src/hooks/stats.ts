// React Query hook for the stats endpoint. Keyed on the full query so preset/range changes
// refetch automatically; disabled until an API key is present.

import type { StatsQuery, StatsResponse } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, qs } from '../api.js';

export function useStats(apiKey: string, query: StatsQuery) {
	return useQuery({
		queryKey: ['stats', query],
		queryFn: () => apiFetch<StatsResponse>(`/api/stats?${qs(query)}`, apiKey),
		enabled: Boolean(apiKey),
	});
}
