// The static-demo backend: a client-side interceptor that answers every `/api/*` request from the
// fabricated dataset, so the whole dashboard runs with NO server (GitHub Pages). Installed once at
// boot, only in the demo build (see main.tsx). Patching window.fetch is the single choke point that
// covers the typed helpers (api.ts) AND the raw fetch() calls (download.ts, transparency.ts).

import {
	BREAKDOWN_DEFAULT_ROWS,
	BREAKDOWN_DIMENSIONS,
	BREAKDOWN_MAX_ROWS,
	type BreakdownDimension,
	type CohortPeriod,
	type CountRow,
	type Interval,
	type SeriesDimension,
} from '@facet/shared';
import { DEMO_SITE_ID } from './constants.js';
import {
	DEMO_EXPERIMENTS,
	DEMO_FUNNELS,
	DEMO_GOALS,
	DEMO_KEYS,
	DEMO_SERIES_DEFAULT_KEYS,
	DEMO_SERIES_MAX_KEYS,
	DEMO_SITE,
	type DemoStatsFilter,
	buildAnomalies,
	buildBreakdown,
	buildClock,
	buildConversions,
	buildCube,
	buildDimensionSeries,
	buildDistribution,
	buildExperimentResult,
	buildFunnelReport,
	buildInteractions,
	buildJourneys,
	buildNlQuery,
	buildPathTree,
	buildRealtime,
	buildRetention,
	buildStats,
	defaultInterval,
} from './dataset.js';

const DAY_MS = 86_400_000;
/** Server-side maximum queryable span (`MAX_RANGE_DAYS`); beyond it the real API is 400 range_too_large. */
const MAX_RANGE_MS = 90 * DAY_MS;
/** The real export caps a breakdown at `EXPORT_MAX_ROWS`; `limit` outside 1..this is a 400. */
const EXPORT_MAX_ROWS = 10_000;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * A validated window, or the error the real API would answer with.
 *
 * Previously `Number(param) || fallback` quietly substituted a trailing 7-day window whenever a
 * caller sent no range — or sent `start=0&end=0`, which the server rejects with `bad_range`. That
 * turned a client bug into plausible-looking data in the one build where nobody can check it against
 * a server. Range handling now mirrors `assertRange`.
 */
type ParsedRange = { start: number; end: number; interval: Interval } | { error: Response };

function parseRange(url: URL): ParsedRange {
	const start = Number(url.searchParams.get('start'));
	const end = Number(url.searchParams.get('end'));
	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		return { error: json({ error: 'bad_range' }, 400) };
	}
	if (end <= start) return { error: json({ error: 'bad_range' }, 400) };
	if (end - start > MAX_RANGE_MS) return { error: json({ error: 'range_too_large' }, 400) };
	const raw = url.searchParams.get('interval');
	// The real handler falls back to hour/day by span, not unconditionally to `day`.
	const interval: Interval = raw === 'hour' || raw === 'day' ? raw : defaultInterval(start, end);
	return { start, end, interval };
}

/** The exact-match dimension filters `/api/stats` accepts. Absent params stay unconstrained. */
function parseFilter(url: URL): DemoStatsFilter {
	const read = (k: string) => url.searchParams.get(k) ?? undefined;
	return {
		path: read('path'),
		referrer: read('referrer'),
		country: read('country'),
		device: read('device'),
		channel: read('channel'),
	};
}

/** The dimension filters `/api/stats/distribution` refuses: `event_sessions` has no column for them,
 * and the real route 400s rather than answering the UNFILTERED distribution under a filtered label.
 * Mirrored here so a caller cannot discover the restriction only in production. */
const DISTRIBUTION_UNSUPPORTED = ['hostname', 'path', 'referrer', 'country', 'device'] as const;

const SERIES_DIMENSIONS: SeriesDimension[] = ['path', 'referrer', 'country', 'device', 'channel'];

/** `/api/stats/timeseries`. `dimension` is required upstream (there is no default to guess) and
 * `limit` is validated by the shared valibot schema, so both are 400s here rather than clamps. */
function timeseriesResponse(url: URL, start: number, end: number, interval: Interval): Response {
	const dimension = url.searchParams.get('dimension') ?? '';
	if (!SERIES_DIMENSIONS.includes(dimension as SeriesDimension)) {
		return json({ error: 'validation_failed' }, 400);
	}
	const limitRaw = url.searchParams.get('limit');
	let limit = DEMO_SERIES_DEFAULT_KEYS;
	if (limitRaw !== null) {
		limit = Number(limitRaw);
		if (!Number.isInteger(limit) || limit < 1 || limit > DEMO_SERIES_MAX_KEYS) {
			return json({ error: 'validation_failed' }, 400);
		}
	}
	return json(
		buildDimensionSeries(
			start,
			end,
			interval,
			dimension as SeriesDimension,
			limit,
			parseFilter(url),
		),
	);
}

function csvResponse(name: string, columns: string[], rows: (string | number)[][]): Response {
	const body = [columns.join(','), ...rows.map((r) => r.join(','))].join('\n');
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${name}.csv"`,
		},
	});
}

/**
 * `/api/stats/export`. The real route answers `{ columns, rows }` for JSON and a matching header row
 * for CSV — a tabular envelope, not the raw domain objects. The mock used to return bare arrays of
 * `{key,count}` / series points, so any consumer written against the demo would have been written
 * against a shape the deployment never sends.
 */
function exportResponse(url: URL): Response {
	const range = parseRange(url);
	if ('error' in range) return range.error;
	const { start, end, interval } = range;
	const kind = url.searchParams.get('kind') ?? 'series';
	const format = url.searchParams.get('format') ?? 'csv';
	if (format !== 'csv' && format !== 'json') {
		return json({ error: 'bad_request' }, 400);
	}
	const stats = buildStats(start, end, interval);

	let columns: string[];
	let rows: (string | number)[][];
	let name: string;

	if (kind === 'series') {
		columns = ['bucket_start_iso', 'bucket_start_ms', 'pageviews', 'visitors'];
		rows = stats.series.map((p) => [new Date(p.t).toISOString(), p.t, p.pageviews, p.visitors]);
		name = `facet-series-${start}-${end}`;
	} else if (kind === 'breakdown') {
		const dimension = url.searchParams.get('dimension') ?? '';
		const lists: Record<string, CountRow[]> = {
			path: stats.top_paths,
			referrer: stats.top_referrers,
			country: stats.top_countries,
			device: stats.top_devices,
			channel: stats.channels,
			event: stats.top_events,
		};
		const list = lists[dimension];
		// The real route 400s on an unknown/missing dimension rather than silently exporting paths.
		if (!list) return json({ error: 'bad_request' }, 400);
		const limitRaw = url.searchParams.get('limit');
		if (limitRaw !== null) {
			const limit = Number(limitRaw);
			if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_MAX_ROWS) {
				return json({ error: 'bad_request' }, 400);
			}
		}
		columns = ['key', 'count'];
		rows = list
			.slice(0, limitRaw !== null ? Number(limitRaw) : 100)
			.map((r) => [r.key, r.count]);
		name = `facet-${dimension}-${start}-${end}`;
	} else {
		return json({ error: 'bad_request' }, 400);
	}

	return format === 'json' ? json({ columns, rows }) : csvResponse(name, columns, rows);
}

/** Route one intercepted /api/* request to its fixture. Returns a Response, or null to pass through. */
function route(url: URL, method: string, body: unknown): Response | null {
	const p = url.pathname;

	// The demo has no CRM database, which the real Worker reports before it authenticates anything —
	// including for a write. Answered ahead of the read-only guard so the CRM tab shows its
	// "extension not enabled" explanation rather than a 403 that would read as a permissions problem.
	if (p === '/api/crm' || p.startsWith('/api/crm/')) {
		return json({ error: 'crm_unavailable' }, 501);
	}

	// No SESSION_SECRET on a static demo, so there is no operator session to report — the same 503
	// the real /api/auth routes answer with when account auth is not configured.
	if (p.startsWith('/api/auth/')) {
		return json({ error: 'auth_unavailable' }, 503);
	}

	// Admin writes are refused: the demo is strictly read-only.
	if (method !== 'GET' && p !== '/api/stats/query') {
		return json({ error: 'demo_read_only' }, 403);
	}

	// Provenance/transparency: report "unconfigured" (fetchMaybe treats 404 as null).
	if (p.startsWith('/api/transparency/')) return new Response(null, { status: 404 });

	// Natural-language "Ask". The window travels in the BODY here, not the querystring, and the real
	// handler validates it with the same assertRange as every other read.
	if (p === '/api/stats/query') {
		const b = (typeof body === 'object' && body ? body : {}) as {
			question?: unknown;
			start?: unknown;
			end?: unknown;
		};
		const question = typeof b.question === 'string' ? b.question : '';
		if (question.length === 0 || question.length > 500) {
			return json({ error: 'bad_request' }, 400);
		}
		const start = Number(b.start);
		const end = Number(b.end);
		if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
			return json({ error: 'bad_range' }, 400);
		}
		if (end - start > MAX_RANGE_MS) return json({ error: 'range_too_large' }, 400);
		return json(buildNlQuery(question, start, end));
	}

	// Endpoints with no range at all, answered before the range is parsed.
	switch (p) {
		case '/api/stats/realtime':
			return json(buildRealtime());
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
			// The real admin route 400s without site_id and lists only that site's keys.
			return url.searchParams.get('site_id') === DEMO_SITE_ID
				? json({ keys: DEMO_KEYS })
				: json({ error: 'bad_request' }, 400);
		case '/api/flags':
			return json({ flags: [] });
		case '/api/stats/export':
			return exportResponse(url);
	}

	// Everything below is range-scoped, and the real API refuses to answer any of it without a valid
	// window — so a caller that has not resolved its range yet gets the same 400 here as in production.
	const range = parseRange(url);
	if ('error' in range) return range.error;
	const { start, end, interval } = range;
	const periodRaw = url.searchParams.get('period') ?? 'week';
	if (periodRaw !== 'day' && periodRaw !== 'week') {
		return json({ error: 'bad_request' }, 400);
	}
	const period: CohortPeriod = periodRaw;

	switch (p) {
		case '/api/stats':
			return json(buildStats(start, end, interval, parseFilter(url)));
		case '/api/stats/breakdown': {
			const dimension = url.searchParams.get('dimension') ?? '';
			// The real route validates `dimension` against the picklist and 400s on anything else,
			// rather than defaulting to paths under whatever label the caller asked for.
			if (!BREAKDOWN_DIMENSIONS.includes(dimension as BreakdownDimension)) {
				return json({ error: 'bad_request' }, 400);
			}
			const limitRaw = url.searchParams.get('limit');
			const limit = limitRaw === null ? BREAKDOWN_DEFAULT_ROWS : Number(limitRaw);
			if (!Number.isInteger(limit) || limit < 1 || limit > BREAKDOWN_MAX_ROWS) {
				return json({ error: 'bad_request' }, 400);
			}
			return json(
				buildBreakdown(
					start,
					end,
					interval,
					dimension as BreakdownDimension,
					limit,
					parseFilter(url),
				),
			);
		}
		case '/api/stats/cube':
			return json(buildCube(start, end, interval));
		case '/api/stats/anomalies':
			return json(buildAnomalies(start, end));
		case '/api/stats/retention':
			return json(buildRetention(period, start, end));
		case '/api/stats/interactions':
			return json(buildInteractions(start, end));
		case '/api/stats/distribution': {
			const unsupported = DISTRIBUTION_UNSUPPORTED.filter(
				(param) => url.searchParams.get(param) !== null,
			);
			if (unsupported.length > 0) {
				return json(
					{
						error: 'unsupported_filter',
						message: `distribution cannot be filtered by ${unsupported.join(', ')}; only channel is a session column`,
					},
					400,
				);
			}
			return json(
				buildDistribution(start, end, url.searchParams.get('channel') ?? undefined),
			);
		}
		case '/api/stats/timeseries':
			return timeseriesResponse(url, start, end, interval);
		case '/api/stats/path-tree':
			return json(buildPathTree(start, end, parseFilter(url)));
		case '/api/stats/journeys':
			return json(buildJourneys(start, end));
		case '/api/stats/clock':
			return json(buildClock(start, end));
		case '/api/stats/experiment': {
			// The real route resolves the experiment and its goal before computing anything.
			const id = url.searchParams.get('experiment_id') ?? '';
			const goalType = url.searchParams.get('goal_type');
			const goalValue = url.searchParams.get('goal_value') ?? '';
			if ((goalType !== 'event' && goalType !== 'path') || goalValue.length === 0) {
				return json({ error: 'bad_goal' }, 400);
			}
			if (!DEMO_EXPERIMENTS.some((e) => e.id === id)) {
				return json({ error: 'not_found' }, 404);
			}
			return json(buildExperimentResult(start, end));
		}
		case '/api/stats/conversions': {
			const goalId = url.searchParams.get('goal_id') ?? '';
			// An unknown goal is a 404 upstream, not someone else's numbers under its id.
			if (!DEMO_GOALS.some((g) => g.id === goalId)) {
				return json({ error: 'not_found' }, 404);
			}
			return json(buildConversions(goalId, start, end));
		}
	}

	// Funnel report: /api/funnels/:id/report — 404 for an id this deployment does not have.
	const funnelId = /^\/api\/funnels\/([^/]+)\/report$/.exec(p)?.[1];
	if (funnelId !== undefined) {
		return DEMO_FUNNELS.some((f) => f.id === funnelId)
			? json(buildFunnelReport(start, end))
			: json({ error: 'not_found' }, 404);
	}

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
