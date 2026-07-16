// Dashboard API client: typed fetch wrappers around the Countless stats endpoints. Uses the
// shared response types so the UI and Worker never drift. Every network call goes through
// apiFetch so auth + error handling stay in one place.

import type { StatsQuery, StatsResponse } from '@countless/shared';

/** Serialize a StatsQuery to a querystring, omitting optional params when unset. */
export function qs(query: StatsQuery): string {
	const params = new URLSearchParams({
		site_id: query.site_id,
		start: String(query.start),
		end: String(query.end),
	});
	if (query.hostname) params.set('hostname', query.hostname);
	if (query.interval) params.set('interval', query.interval);
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

/** Fetch the summary + series + top-N stats for a site. */
export function fetchStats(apiKey: string, query: StatsQuery): Promise<StatsResponse> {
	return apiFetch<StatsResponse>(`/api/stats?${qs(query)}`, apiKey);
}
