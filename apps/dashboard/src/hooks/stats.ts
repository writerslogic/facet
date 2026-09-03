// React Query hooks for small stats-adjacent reads used outside the Overview.

import type { Freshness, StatsFreshnessResponse } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, qs } from '../api.js';
import { siteQueryKey } from '../lib/queryKeys.js';
import type { Range } from '../state.js';

/** Session-materialization freshness for a site/range, without loading unrelated analytics. */
export function useFreshness(apiKey: string, siteId: string, range: Range, enabled = true) {
	return useQuery({
		queryKey: siteQueryKey('freshness', siteId, range),
		queryFn: async (): Promise<Freshness | null> => {
			const res = await apiFetch<StatsFreshnessResponse>(
				`/api/stats/freshness?${qs({ site_id: siteId, start: range.start, end: range.end })}`,
				apiKey,
			);
			return res.meta ?? null;
		},
		enabled: Boolean(siteId) && enabled && range.end > range.start,
	});
}
