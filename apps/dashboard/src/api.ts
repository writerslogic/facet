// Dashboard API client: typed fetch wrappers around the Facet stats endpoints. Uses the
// shared response types so the UI and Worker never drift. Every network call goes through
// apiFetch so auth + error handling stay in one place.

import type { StatsQuery, StatsResponse } from '@facet/shared';

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

/** Canonical GET helper: attaches the bearer token and unwraps `{ error }` on failure. */
export async function apiFetch<T>(path: string, apiKey: string): Promise<T> {
	const res = await fetch(path, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? 'request_failed');
	}
	return (await res.json()) as T;
}

/** Canonical POST helper: attaches the bearer token + JSON body and unwraps `{ error }` on failure. */
export async function apiPost<T>(path: string, apiKey: string, body: unknown): Promise<T> {
	const res = await fetch(path, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const errorBody = (await res.json().catch(() => ({}))) as {
			error?: string;
		};
		throw new Error(errorBody.error ?? 'request_failed');
	}
	return (await res.json()) as T;
}

/** Fetch the summary + series + top-N stats for a site. */
export function fetchStats(apiKey: string, query: StatsQuery): Promise<StatsResponse> {
	return apiFetch<StatsResponse>(`/api/stats?${qs(query)}`, apiKey);
}

/**
 * The error code for a failed response: the API's own `{ error }` when it sent one, otherwise
 * derived from the status. The fallback matters for the session routes, whose whole UI hinges on
 * telling a 501 (this deployment has no CRM database) apart from a 403 (your role is too low) — a
 * proxy or a truncated body must not collapse both into an indistinguishable "request_failed".
 */
function errorCode(status: number, body: { error?: string }): string {
	if (body.error) return body.error;
	if (status === 501) return 'crm_unavailable';
	if (status === 403) return 'forbidden';
	if (status === 401) return 'unauthorized';
	return 'request_failed';
}

/**
 * Canonical helper for the SESSION-authenticated API (`/api/auth/me`, `/api/crm/*`).
 *
 * Deliberately sends no `Authorization` header: those routes refuse an API key by design, because a
 * `clk_` key reads aggregate analytics and is handed out accordingly while contact PII is not. Auth
 * is the HttpOnly session cookie, which a same-origin request carries on its own — `same-origin` is
 * the browser default and is stated here so the intent survives the next refactor.
 */
export async function sessionFetch<T>(
	path: string,
	init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<T> {
	const method = init?.method ?? 'GET';
	const res = await fetch(path, {
		method,
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
	return (await res.json()) as T;
}
