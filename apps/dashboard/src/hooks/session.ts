// React Query hooks for the operator's OWN account session (`/api/auth/*`), as distinct from the
// site-scoped API-key path and from the deployment-wide admin token. Auth is the HttpOnly session
// cookie, so every call goes through the session helpers and carries no `Authorization` header.
//
// A 401 and a deployment with no SESSION_SECRET are terminal query states; retrying cannot change
// either one during the request.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionFetch, sessionSend } from '../api.js';

/** The signed-in operator and their team roles, as `GET /api/auth/me` reports them. */
export interface SessionMe {
	user: { id: string; email: string; name: string | null };
	memberships: { teamId: string; role: string }[];
	sites?: { id: string; name: string; domain: string; role: string }[];
}

function isTerminalSessionError(error: unknown): boolean {
	return (
		error instanceof Error &&
		['auth_unavailable', 'unauthorized', 'unauthenticated', 'forbidden'].includes(error.message)
	);
}

const retry = (failureCount: number, error: unknown): boolean =>
	!isTerminalSessionError(error) && failureCount < 1;

export function useSessionMe() {
	return useQuery({
		queryKey: ['session', 'me'],
		queryFn: () => sessionFetch<SessionMe>('/api/auth/me'),
		retry,
	});
}

/** Exchange a single-use token when the dashboard opens its `/login?token=…` link. */
export function useVerifySessionToken(token: string | null) {
	return useQuery({
		queryKey: ['session', 'verify', token],
		queryFn: () =>
			sessionFetch<{ user: { id: string; email: string } }>('/api/auth/verify', {
				method: 'POST',
				body: { token },
			}),
		enabled: Boolean(token),
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/** Ask the deployment to email a passwordless sign-in link. */
export function useRequestSessionLink() {
	return useMutation({
		mutationFn: (email: string) =>
			sessionSend('/api/auth/request', { method: 'POST', body: { email } }),
	});
}

/**
 * End every session this operator holds, anywhere, including the one making the request.
 *
 * Invalidates the session cache on success. Analytics queries use a site API key, which this does not
 * affect and must not appear to.
 */
export function useLogoutEverywhere() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => sessionSend('/api/auth/logout-everywhere', { method: 'POST' }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['session'] });
		},
	});
}
