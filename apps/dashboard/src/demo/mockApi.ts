// The static-demo backend: a client-side interceptor that answers every `/api/*` request from the
// fabricated dataset, so the whole dashboard runs with NO server (GitHub Pages). Installed once at
// boot, only in the demo build (see main.tsx). Patching window.fetch is the single choke point that
// covers the typed helpers (api.ts) AND the raw fetch() calls (download.ts, transparency.ts).

import type { CohortPeriod, Interval } from '@facet/shared';
import { DEMO_API_KEY, DEMO_LABEL, DEMO_SITE_ID } from './constants.js';
import {
	DEMO_EXPERIMENTS,
	DEMO_FUNNELS,
	DEMO_GOALS,
	DEMO_KEYS,
	DEMO_SITE,
	buildAnomalies,
	buildConversions,
	buildCube,
	buildExperimentResult,
	buildFunnelReport,
	buildInteractions,
	buildNlQuery,
	buildRealtime,
	buildRetention,
	buildStats,
} from './dataset.js';

const DAY_MS = 86_400_000;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Read start/end/interval from the querystring, defaulting to a trailing 7-day daily window. */
function parseRange(url: URL): {
	start: number;
	end: number;
	interval: Interval;
} {
	const now = Date.now();
	const start = Number(url.searchParams.get('start')) || now - 7 * DAY_MS;
	const end = Number(url.searchParams.get('end')) || now;
	const interval = url.searchParams.get('interval') === 'hour' ? 'hour' : 'day';
	return { start, end, interval };
}

function exportResponse(url: URL): Response {
	const { start, end, interval } = parseRange(url);
	const kind = url.searchParams.get('kind') ?? 'series';
	const format = url.searchParams.get('format') ?? 'csv';
	const stats = buildStats(start, end, interval);
	if (kind === 'breakdown') {
		const dim = url.searchParams.get('dimension') ?? 'path';
		const lists: Record<string, { key: string; count: number }[]> = {
			path: stats.top_paths,
			referrer: stats.top_referrers,
			country: stats.top_countries,
			device: stats.top_devices,
			channel: stats.channels,
			event: stats.top_events,
		};
		const list = lists[dim] ?? stats.top_paths;
		if (format === 'json') return json(list);
		const csv = ['key,count', ...list.map((r) => `${r.key},${r.count}`)].join('\n');
		return new Response(csv, {
			status: 200,
			headers: { 'content-type': 'text/csv' },
		});
	}
	if (format === 'json') return json(stats.series);
	const csv = [
		't,pageviews,visitors',
		...stats.series.map((p) => `${p.t},${p.pageviews},${p.visitors}`),
	].join('\n');
	return new Response(csv, {
		status: 200,
		headers: { 'content-type': 'text/csv' },
	});
}

/** Route one intercepted /api/* request to its fixture. Returns a Response, or null to pass through. */
function route(url: URL, method: string, body: unknown): Response | null {
	const p = url.pathname;

	// Admin writes are refused: the demo is strictly read-only.
	if (method !== 'GET' && p !== '/api/stats/query') {
		return json({ error: 'demo_read_only' }, 403);
	}

	// Provenance/transparency: report "unconfigured" (fetchMaybe treats 404 as null).
	if (p.startsWith('/api/transparency/')) return new Response(null, { status: 404 });

	// Natural-language "Ask".
	if (p === '/api/stats/query') {
		const question =
			typeof body === 'object' && body
				? String((body as { question?: unknown }).question ?? '')
				: '';
		return json(buildNlQuery(question));
	}

	const { start, end, interval } = parseRange(url);
	const period: CohortPeriod = url.searchParams.get('period') === 'week' ? 'week' : 'day';

	switch (p) {
		case '/api/stats':
			return json(buildStats(start, end, interval));
		case '/api/stats/cube':
			return json(buildCube(start, end, interval));
		case '/api/stats/anomalies':
			return json(buildAnomalies());
		case '/api/stats/realtime':
			return json(buildRealtime());
		case '/api/stats/retention':
			return json(buildRetention(period));
		case '/api/stats/interactions':
			return json(buildInteractions());
		case '/api/stats/experiment':
			return json(buildExperimentResult());
		case '/api/stats/conversions':
			return json(buildConversions(url.searchParams.get('goal_id') ?? 'g1'));
		// Read lists — served for both the analytics (`/api/stats/*`) and admin surfaces.
		case '/api/stats/experiments':
		case '/api/experiments':
			return json({ experiments: DEMO_EXPERIMENTS });
		case '/api/stats/goals':
		case '/api/goals':
			return json({ goals: DEMO_GOALS });
		case '/api/stats/funnels':
		case '/api/funnels':
			return json({ funnels: DEMO_FUNNELS });
		case '/api/sites':
			return json({ sites: [DEMO_SITE] });
		case '/api/keys':
			return json({ keys: DEMO_KEYS });
		case '/api/flags':
			return json({ flags: [] });
		case '/api/stats/export':
			return exportResponse(url);
	}

	// Funnel report: /api/funnels/:id/report
	if (/^\/api\/funnels\/[^/]+\/report$/.test(p)) return json(buildFunnelReport());

	// Any other /api/* GET: an empty-but-valid shape beats a hard error in the demo.
	return json({ error: 'not_found' }, 404);
}

/** Install the demo interceptor + seed a demo admin token so the Settings tab shows populated. Idempotent. */
export function installDemoApi(): void {
	try {
		sessionStorage.setItem('facet.adminToken', 'demo-read-only');
	} catch {
		// sessionStorage unavailable — Settings will just show its token gate.
	}
	const originalFetch = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const req = input instanceof Request ? input : null;
		const rawUrl = req ? req.url : String(input);
		const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
		let url: URL;
		try {
			url = new URL(rawUrl, window.location.origin);
		} catch {
			return originalFetch(input, init);
		}
		if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
		let parsed: unknown = null;
		if (method !== 'GET' && init?.body) {
			try {
				parsed = JSON.parse(String(init.body));
			} catch {
				// non-JSON body; leave null
			}
		}
		return route(url, method, parsed) ?? originalFetch(input, init);
	};
}

/** The synthetic demo profile the static build auto-loads (skips the key gate). */
export const DEMO_PROFILE = {
	siteId: DEMO_SITE_ID,
	apiKey: DEMO_API_KEY,
	label: DEMO_LABEL,
};
