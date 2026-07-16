// React Query mutation for the natural-language analytics endpoint. POSTs the question + range and
// returns the constrained NlQueryResult. A mutation (not a query) since it's user-triggered on submit.

import type { NlQueryResult } from '@countless/shared';
import { useMutation } from '@tanstack/react-query';
import { apiPost } from '../api.js';
import type { Range } from '../state.js';

export function useNlQuery(apiKey: string, siteId: string, range: Range) {
	return useMutation({
		mutationFn: (question: string) =>
			apiPost<NlQueryResult>('/api/stats/query', apiKey, {
				site_id: siteId,
				question,
				start: range.start,
				end: range.end,
			}),
	});
}
