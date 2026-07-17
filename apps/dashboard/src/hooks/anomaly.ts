// React Query hook for the anomaly-detection endpoint: fetches the detected pageview anomalies for
// a site over the selected range via the API-key stats endpoint.

import type { AnomaliesResponse } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api.js';
import type { Range } from '../state.js';

export function useAnomalies(apiKey: string, siteId: string, range: Range) {
	return useQuery({
		queryKey: ['anomalies', siteId, range],
		queryFn: () =>
			apiFetch<AnomaliesResponse>(
				`/api/stats/anomalies?site_id=${siteId}&start=${range.start}&end=${range.end}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId),
	});
}
