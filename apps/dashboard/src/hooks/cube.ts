// Hydrate the dimensional cube for a range, once. The client then slices it in memory (see lib/cube.ts)
// for instant device/country/channel filtering with no further server reads. Keyed by site+range+interval
// so it refetches only when the range changes, and cached for a minute.

import type { CubeResponse } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, qs } from '../api.js';
import type { Range } from '../state.js';

export function useCube(apiKey: string, siteId: string, range: Range, interval: 'hour' | 'day') {
	return useQuery({
		queryKey: ['cube', siteId, range, interval],
		queryFn: () =>
			apiFetch<CubeResponse>(
				`/api/stats/cube?${qs({ site_id: siteId, start: range.start, end: range.end, interval })}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId),
		staleTime: 60_000,
		// Hold the previous range's cube during a range change so client-side slices keep rendering
		// instead of falling back to EMPTY_CELLS mid-swap. Scoped to the same site so a site switch
		// resets rather than slicing the old site's cube.
		placeholderData: (prev, prevQuery) =>
			prevQuery?.queryKey[1] === siteId ? prev : undefined,
	});
}
