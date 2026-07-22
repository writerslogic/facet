// React Query hook for the cohort-retention endpoint: fetches the retention triangle for a site over
// the selected range via the API-key stats endpoint. `period` (week default / day) is a raw query
// param (not part of StatsQuery), so it is included in the query key to refetch on toggle.

import type { CohortPeriod, CohortRetentionResponse } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api.js';
import type { Range } from '../state.js';

export function useRetention(apiKey: string, siteId: string, range: Range, period: CohortPeriod) {
	return useQuery({
		queryKey: ['retention', siteId, range, period],
		queryFn: () =>
			apiFetch<CohortRetentionResponse>(
				`/api/stats/retention?site_id=${siteId}&start=${range.start}&end=${range.end}&period=${period}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId),
	});
}
