// React Query hook for `GET /api/stats/breakdown` — the one read that prefers the columnar store.
// `dimension` and `limit` are raw query params rather than `StatsQuery` fields, so both join the
// query key: changing either is a different question, not a re-render of the same one.

import type { BreakdownDimension, BreakdownResponse, StatsQuery } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, qs } from '../api.js';
import { siteQueryKey } from '../lib/queryKeys.js';

export function useBreakdown(
	apiKey: string,
	query: StatsQuery,
	dimension: BreakdownDimension,
	limit: number,
) {
	return useQuery({
		queryKey: siteQueryKey('breakdown', query.site_id, query, dimension, limit),
		queryFn: () =>
			apiFetch<BreakdownResponse>(
				`/api/stats/breakdown?${qs(query)}&dimension=${dimension}&limit=${limit}`,
				apiKey,
			),
		enabled: Boolean(apiKey && query.site_id) && query.end > query.start,
		// Switching dimension re-reads the same range, so keep the current table on screen rather
		// than collapsing to a skeleton for one round trip. Scoped to the same site: a site swap must
		// NOT leave the previous site's rows under the new label.
		placeholderData: (prev, prevQuery) =>
			prevQuery?.queryKey[1] === query.site_id ? prev : undefined,
	});
}
