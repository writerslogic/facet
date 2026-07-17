// Interaction-events hook: system interaction counts ($exposure/form_submit/etc), distinct from
// marketer-defined Custom Events.

import type { CountRow } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api.js';
import type { Range } from '../state.js';

export function useInteractions(apiKey: string, siteId: string, range: Range) {
	return useQuery({
		queryKey: ['interactions', siteId, range],
		queryFn: () =>
			apiFetch<{ interactions: CountRow[] }>(
				`/api/stats/interactions?site_id=${siteId}&start=${range.start}&end=${range.end}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId),
	});
}
