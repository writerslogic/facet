// React Query mutation for the natural-language analytics endpoint. POSTs the question plus the window
// it should run over, and returns the constrained NlQueryResult. A mutation (not a query) since it's
// user-triggered on submit.
//
// The window travels in the mutation VARIABLES rather than the hook arguments: the Ask panel lets a
// reader re-run the same question over a different window (e.g. "and last 24h?") without moving the
// global range every other tab is bound to, so the range can't be fixed at hook-construction time.

import type { NlQueryResult } from '@facet/shared';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { apiPost } from '../api.js';
import type { Range } from '../state.js';

/**
 * Server-side cap on the question body (see the `/stats/query` handler). Mirrored here so an over-long
 * question is stopped at the input rather than coming back as an opaque `bad_request`.
 */
export const QUESTION_MAX_LEN = 500;
export const ASK_TIMEOUT_MS = 20_000;

export interface NlQueryVars {
	question: string;
	/** The window this question is answered over — not necessarily the dashboard's global range. */
	range: Range;
}

export function useNlQuery(apiKey: string, siteId: string) {
	const active = useRef<{
		controller: AbortController;
		reason: 'request_cancelled' | 'request_timeout';
	} | null>(null);
	const mutation = useMutation<NlQueryResult, Error, NlQueryVars>({
		mutationFn: async ({ question, range }) => {
			if (active.current) {
				active.current.reason = 'request_cancelled';
				active.current.controller.abort();
			}
			const request = {
				controller: new AbortController(),
				reason: 'request_timeout' as const,
			};
			active.current = request;
			const timeout = window.setTimeout(() => request.controller.abort(), ASK_TIMEOUT_MS);
			try {
				return await apiPost<NlQueryResult>(
					'/api/stats/query',
					apiKey,
					{
						site_id: siteId,
						question,
						start: range.start,
						end: range.end,
					},
					request.controller.signal,
				);
			} catch (error) {
				if (request.controller.signal.aborted) throw new Error(request.reason);
				throw error;
			} finally {
				window.clearTimeout(timeout);
				if (active.current === request) active.current = null;
			}
		},
	});
	const cancel = useCallback(() => {
		if (!active.current) return;
		active.current.reason = 'request_cancelled';
		active.current.controller.abort();
	}, []);
	return { ...mutation, cancel };
}
