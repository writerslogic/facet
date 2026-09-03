// Dashboard API client: typed fetch wrappers around the Facet stats endpoints. Uses the
// shared response types so the UI and Worker never drift. Every network call goes through
// apiFetch so auth + error handling stay in one place.

import type { StatsQuery } from '@facet/shared';

/** Serialize a StatsQuery to a querystring, omitting optional params when unset. */
export function qs(query: StatsQuery): string {
	const params = new URLSearchParams({
		site_id: query.site_id,
		start: String(query.start),
		end: String(query.end),
	});
	if (query.hostname) params.set('hostname', query.hostname);
	if (query.interval) params.set('interval', query.interval);
	if (query.path) params.set('path', query.path);
	if (query.referrer) params.set('referrer', query.referrer);
	if (query.country) params.set('country', query.country);
	if (query.device) params.set('device', query.device);
	if (query.channel) params.set('channel', query.channel);
	return params.toString();
}

/** Canonical GET helper. A nonempty key is the legacy/programmatic path; otherwise the browser's
 * HttpOnly same-origin session authenticates the request without exposing a credential to JS. */
export async function apiFetch<T>(path: string, apiKey: string): Promise<T> {
	const res = await fetch(path, {
		credentials: 'same-origin',
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? 'request_failed');
	}
	return (await res.json()) as T;
}

/** Canonical POST helper: attaches the bearer token + JSON body and unwraps `{ error }` on failure. */
export async function apiPost<T>(
	path: string,
	apiKey: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const res = await fetch(path, {
		method: 'POST',
		credentials: 'same-origin',
		headers: {
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		const errorBody = (await res.json().catch(() => ({}))) as {
			error?: string;
		};
		throw new Error(errorBody.error ?? 'request_failed');
	}
	return (await res.json()) as T;
}

/**
 * The error code for a failed response: the API's own `{ error }` when it sent one, otherwise
 * derived from the status, so a proxy or truncated body still produces a useful auth failure.
 */
function errorCode(status: number, body: { error?: string }): string {
	if (body.error) return body.error;
	if (status === 403) return 'forbidden';
	if (status === 401) return 'unauthorized';
	return 'request_failed';
}

interface SessionInit {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	body?: unknown;
}

/**
 * Issue a request to the SESSION-authenticated API and raise the API's own error code on failure.
 *
 * Deliberately sends no `Authorization` header. Auth is the HttpOnly session cookie, which a
 * same-origin request carries on its own — `same-origin` is stated so the intent survives refactors.
 */
async function sessionRequest(path: string, init?: SessionInit): Promise<Response> {
	const res = await fetch(path, {
		method: init?.method ?? 'GET',
		credentials: 'same-origin',
		...(init?.body === undefined
			? {}
			: {
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(init.body),
				}),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(errorCode(res.status, body));
	}
	return res;
}

/** Canonical helper for session-authenticated JSON routes. */
export async function sessionFetch<T>(path: string, init?: SessionInit): Promise<T> {
	return (await sessionRequest(path, init)).json() as Promise<T>;
}

/**
 * A session route that answers 204 and returns nothing — `/api/auth/logout-everywhere` is the one
 * that matters here.
 *
 * Separate from `sessionFetch` rather than a status check inside it, because the difference is in the
 * TYPE and not only in the parsing: a 204 has no body, so there is no `T` to promise and calling
 * `.json()` on it throws a SyntaxError. Routed through `sessionFetch` that failure would surface as a
 * rejected mutation for a request the server in fact completed — the worst possible reading of "you
 * are signed out everywhere", since the sessions really are gone and the UI would say they are not.
 */
export async function sessionSend(path: string, init: SessionInit): Promise<void> {
	await sessionRequest(path, init);
}
