// React Query hooks for the operator's OWN account session (`/api/auth/*`), as distinct from the
// site-scoped API-key path and from the deployment-wide admin token. Auth is the HttpOnly session
// cookie, so every call goes through the session helpers and carries no `Authorization` header.
//
// Failure classification is `crmBlockOf`, reused rather than reimplemented: a 401 (no session) and a
// 503 (this deployment has no SESSION_SECRET, so accounts are off entirely) mean the same things here
// as they do on the CRM routes, and a second copy of that mapping is how the two drift apart.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionFetch, sessionSend } from '../api.js';
import { crmBlockOf } from '../lib/crm.js';

/** The signed-in operator and their team roles, as `GET /api/auth/me` reports them. */
export interface SessionMe {
	user: { id: string; email: string; name: string | null };
	memberships: { teamId: string; role: string }[];
}

/** No session, no accounts and no role are facts about the deployment or the operator, not transient
 * failures — re-asking cannot change any of them. Same policy as the CRM hooks, same reason. */
const retry = (failureCount: number, error: unknown): boolean =>
	crmBlockOf(error) === null && failureCount < 1;

export function useSessionMe() {
	return useQuery({
		queryKey: ['session', 'me'],
		queryFn: () => sessionFetch<SessionMe>('/api/auth/me'),
		retry,
	});
}

/**
 * End every session this operator holds, anywhere, including the one making the request.
 *
 * Invalidates the session and CRM caches on success because both are read with the cookie that has
 * just stopped resolving — leaving them would let the CRM tab keep rendering contact names out of a
 * cache whose authority is gone. The analytics queries are deliberately untouched: they authenticate
 * with a site API key, which this does not affect and must not appear to.
 */
export function useLogoutEverywhere() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => sessionSend('/api/auth/logout-everywhere', { method: 'POST' }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['session'] });
			void qc.invalidateQueries({ queryKey: ['crm'] });
		},
	});
}
