// GET /api/stats — API-key authenticated read endpoint. Validates the range, enforces that the key
// owns the requested site, and assembles the full stats response.

import {
	BREAKDOWN_DEFAULT_ROWS,
	BreakdownQuerySchema,
	type CountRow,
	DimensionSeriesQuerySchema,
	type StatsFilter,
	type StatsQueryInput,
	StatsQuerySchema,
	type StatsResponse,
} from '@facet/shared';
import {
	buildAnalyticsReportCredential,
	issueCredential,
	signDetachedJws,
	signExport,
	signResponse,
	verificationMethodId,
} from '@facet/trust';
import { vValidator } from '@hono/valibot-validator';
import { Hono } from 'hono';
import { detectAnomalies } from '../db/anomaly.js';
import { breakdown } from '../db/breakdown.js';
import {
	getGoalById,
	getSiteMeta,
	listExperiments,
	listFunnels,
	listGoals,
} from '../db/catalog.js';
import { goalConversions } from '../db/conversions.js';
import { experimentResult } from '../db/experiments.js';
import {
	clock,
	dimensionSeries,
	journeys,
	pathTree,
	sessionDistribution,
	unsupportedDistributionFilters,
} from '../db/insights.js';
import {
	attribution,
	channels,
	cohortRetention,
	cube,
	engagement,
	realtime,
	revenue,
	revenueByChannel,
	series,
	sessionFreshness,
	summary,
	topBrowsers,
	topConnections,
	topCountries,
	topDevices,
	topEvents,
	topInteractions,
	topLanguages,
	topNetworks,
	topOperatingSystems,
	topPaths,
	topReferrers,
	topRegions,
	topScreens,
} from '../db/stats.js';
import type { AppEnv } from '../env.js';
import { aiRunner, answerQuestion } from '../lib/ai.js';
import { requireSiteAccess } from '../lib/auth.js';
import {
	DAY_MS,
	EXPORT_MAX_ROWS,
	HOUR_MS,
	MAX_RANGE_DAYS,
	REALTIME_WINDOW_MS,
} from '../lib/constants.js';
import { toCsv } from '../lib/csv.js';
import { renderDigest } from '../lib/digest.js';
import { ApiError, validationErrorHook } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
	deploymentDid,
	ed25519KeyErrorCode,
	getSigningKey,
	jwksUrl,
	loadEd25519Key,
} from '../lib/signing.js';

export const statsRoutes = new Hono<AppEnv>();

/** Reject an empty range or one exceeding the maximum queryable span. */
function assertRange(start: number, end: number): void {
	if (end <= start) {
		throw new ApiError('bad_range', 400);
	}
	if (end - start > MAX_RANGE_DAYS * DAY_MS) {
		throw new ApiError('range_too_large', 400);
	}
}

/** The bucket granularity for a range: whatever the caller asked for, else hour for a short window
 * and day for a long one. Shared by every time-bucketed read so they all bucket identically. */
function intervalFor(query: StatsQueryInput): 'hour' | 'day' {
	return query.interval ?? (query.end - query.start <= 48 * HOUR_MS ? 'hour' : 'day');
}

/** Validate a stats query against the key's site + range, returning the internal filter. */
function toStatsFilter(query: StatsQueryInput, siteId: string): StatsFilter {
	if (query.site_id !== siteId) {
		throw new ApiError('site_mismatch', 403);
	}
	assertRange(query.start, query.end);
	return {
		siteId: query.site_id,
		hostname: query.hostname,
		start: query.start,
		end: query.end,
		path: query.path,
		referrer: query.referrer,
		country: query.country,
		device: query.device,
		channel: query.channel,
	};
}

statsRoutes.get(
	'/stats',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const f = toStatsFilter(query, c.get('siteId'));
		const interval = intervalFor(query);
		const [
			summaryResult,
			seriesResult,
			paths,
			referrers,
			events,
			countries,
			devices,
			engagementResult,
			channelsResult,
			freshness,
			browsers,
			operatingSystems,
			screens,
			languages,
			regions,
			networks,
			connections,
			revenueResult,
			revenueByChannelResult,
			attributionResult,
		] = await Promise.all([
			summary(c.env, f),
			series(c.env, f, interval),
			topPaths(c.env, f),
			topReferrers(c.env, f),
			topEvents(c.env, f),
			topCountries(c.env, f),
			topDevices(c.env, f),
			engagement(c.env, f),
			channels(c.env, f),
			sessionFreshness(c.env, f),
			topBrowsers(c.env, f),
			topOperatingSystems(c.env, f),
			topScreens(c.env, f),
			topLanguages(c.env, f),
			topRegions(c.env, f),
			topNetworks(c.env, f),
			topConnections(c.env, f),
			revenue(c.env, f),
			revenueByChannel(c.env, f),
			attribution(c.env, f),
		]);
		const body: StatsResponse = {
			summary: summaryResult,
			series: seriesResult,
			top_paths: paths,
			top_referrers: referrers,
			top_events: events,
			top_countries: countries,
			top_devices: devices,
			engagement: engagementResult,
			channels: channelsResult,
			top_browsers: browsers,
			top_os: operatingSystems,
			top_screens: screens,
			top_languages: languages,
			top_regions: regions,
			top_networks: networks,
			top_connections: connections,
			revenue: revenueResult,
			revenue_by_channel: revenueByChannelResult,
			attribution: attributionResult,
			meta: freshness,
		};
		return c.json(body);
	},
);

// The low-cardinality dimensional cube for a range: the client hydrates this once and slices by
// device/country/channel instantly, with no further server round-trips.
statsRoutes.get(
	'/stats/cube',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const f = toStatsFilter(query, c.get('siteId'));
		const interval = intervalFor(query);
		return c.json({ interval, cells: await cube(c.env, f, interval) });
	},
);

statsRoutes.get(
	'/stats/sessions',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		const [engagementResult, meta] = await Promise.all([
			engagement(c.env, f),
			sessionFreshness(c.env, f),
		]);
		return c.json({ engagement: engagementResult, meta });
	},
);

statsRoutes.get(
	'/stats/channels',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		const [channelsResult, meta] = await Promise.all([
			channels(c.env, f),
			sessionFreshness(c.env, f),
		]);
		return c.json({ channels: channelsResult, meta });
	},
);

// Cohort-retention triangle: visitors grouped by the period of their first activity, then the
// fraction returning n periods later. Same site-scoping + range validation as the sibling reads.
// `period` (day|week, default week) is a raw query param — StatsQuerySchema has no `period` field.
// NOTE: retention depth is bounded by the site salt window (see the response `note`); at the
// default daily window cross-period retention is honestly ~0, not a bug.
statsRoutes.get(
	'/stats/retention',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		const periodRaw = c.req.query('period') ?? 'week';
		if (periodRaw !== 'day' && periodRaw !== 'week') {
			throw new ApiError('bad_request', 400, 'period must be day or week');
		}
		return c.json(await cohortRetention(c.env, f, periodRaw));
	},
);

// One dimension, grouped over the range, with the ordinary filters composed on top. This is the read
// that uses the columnar mirror: it reaches the dimensions D1 stores but no other endpoint surfaces
// (city, timezone, the UTM columns, form factor, currency, hostname), and it falls back to D1
// whenever the mirror is absent or cannot express the query. `source`/`sampled` in the response say
// which store answered, because only the columnar one samples — see `BreakdownResponse`.
statsRoutes.get(
	'/stats/breakdown',
	requireSiteAccess,
	vValidator('query', BreakdownQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const f = toStatsFilter(query, c.get('siteId'));
		return c.json(
			await breakdown(c.env, f, query.dimension, query.limit ?? BREAKDOWN_DEFAULT_ROWS),
		);
	},
);

// Internal/system interactions ($exposure, form_submit, other $-prefixed) shown separately from
// marketer-facing custom events, which exclude them.
statsRoutes.get(
	'/stats/interactions',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		return c.json({ interactions: await topInteractions(c.env, f) });
	},
);

// ── Visualization reads ───────────────────────────────────────────────────────────────────────────
// Five shapes the cube and the flat top-N lists cannot express (box/violin, multi-line, treemap and
// sunburst, chord, nightingale). Every one is API-key authenticated, site-scoped and range-capped by
// the same `requireSiteAccess` + `StatsQuerySchema` + `toStatsFilter` path as the reads above, and
// every one is bounded by a constant rather than by the data. Aggregation is in SQL — see db/insights.ts.

// Session duration + pages-per-session as summary statistics and a bounded histogram. Never per-
// session rows: those are unbounded AND each one is a single visitor's behaviour. Statistics are
// withheld entirely below the anonymity floor (`suppressed: true`), because under it the percentile
// vector is the raw sample re-encoded.
statsRoutes.get(
	'/stats/distribution',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		// A session row carries only channel/entry/exit, so the other filters cannot be honoured.
		// Rejecting is the point: silently ignoring them would return the UNFILTERED distribution
		// under a filtered label, which is worse than no endpoint.
		const unsupported = unsupportedDistributionFilters(f);
		if (unsupported.length > 0) {
			throw new ApiError(
				'unsupported_filter',
				400,
				`distribution cannot be filtered by ${unsupported.join(', ')}; only channel is a session column`,
			);
		}
		return c.json(await sessionDistribution(c.env, f));
	},
);

// One time series per top-N dimension value, for a multi-line chart. The cube already covers
// device/country/channel client-side; the gap this closes is path and referrer. `visitors` is
// deliberately absent — see `DimensionSeriesPoint` for why it would be wrong here.
statsRoutes.get(
	'/stats/timeseries',
	requireSiteAccess,
	vValidator('query', DimensionSeriesQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const f = toStatsFilter(query, c.get('siteId'));
		return c.json(
			await dimensionSeries(c.env, f, query.dimension, intervalFor(query), query.limit),
		);
	},
);

// The URL-prefix tree for a zoomable treemap / sunburst: `/blog/post-a` and `/blog/post-b` roll up
// under `/blog`. Bounded by depth, children per node and distinct paths read; a subtree below the
// k-anonymity floor folds into a synthetic `other` node rather than being labelled.
statsRoutes.get(
	'/stats/path-tree',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		return c.json(await pathTree(c.env, f));
	},
);

// Real entry→exit journeys from the materialized session rows, for a chord diagram or a second
// Sankey. Floored on DISTINCT VISITORS, not sessions — a two-URL behavioural sequence is the most
// re-identifying shape here, and one person reloading must not clear the floor.
statsRoutes.get(
	'/stats/journeys',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		return c.json(await journeys(c.env, f));
	},
);

// Activity folded onto a 7 × 24 grid for a polar/nightingale chart and a day×hour heatmap. UTC
// only, derived by integer arithmetic on the epoch — the codebase treats timestamps as UTC and this
// does not become the one place that silently guesses a local timezone.
statsRoutes.get(
	'/stats/clock',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		return c.json(await clock(c.env, f));
	},
);

// Realtime snapshot: active-visitor proxy (distinct daily hashes) + pageviews over the last few
// minutes. Privacy-safe (no cookies/ids), bounded window, indexed by created_at.
statsRoutes.get('/stats/realtime', requireSiteAccess, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	return c.json(await realtime(c.env, siteId, Date.now(), REALTIME_WINDOW_MS));
});

// Authenticated read-only export of a series or a breakdown as CSV or JSON. Same site-scoping,
// range validation, AND dimension filters (hostname/path/referrer/country/device/channel) as the
// other stats reads — via the same StatsQuerySchema + toStatsFilter every other /stats/* route
// uses — so an export taken while the dashboard is cross-filtered matches what's on screen instead
// of silently exporting the unfiltered site. Output is bounded (series by range, breakdown by
// limit) and CSV cells are formula-injection-safe.
const EXPORT_DIMENSIONS: Record<
	string,
	(env: AppEnv['Bindings'], f: StatsFilter) => Promise<CountRow[]>
> = {
	path: (env, f) => topPaths(env, f, EXPORT_MAX_ROWS),
	referrer: (env, f) => topReferrers(env, f, EXPORT_MAX_ROWS),
	country: (env, f) => topCountries(env, f, EXPORT_MAX_ROWS),
	device: (env, f) => topDevices(env, f),
	event: (env, f) => topEvents(env, f, EXPORT_MAX_ROWS),
	channel: (env, f) => channels(env, f),
};

statsRoutes.get(
	'/stats/export',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const f = toStatsFilter(query, c.get('siteId'));
		const { start, end } = f;
		const format = c.req.query('format') ?? 'csv';
		if (format !== 'csv' && format !== 'json') {
			throw new ApiError('bad_request', 400, 'format must be csv or json');
		}
		const kind = c.req.query('kind') ?? 'series';

		let columns: string[];
		let rows: (string | number)[][];
		let name: string;

		if (kind === 'series') {
			const points = await series(c.env, f, intervalFor(query));
			columns = ['bucket_start_iso', 'bucket_start_ms', 'pageviews', 'visitors'];
			rows = points.map((p) => [new Date(p.t).toISOString(), p.t, p.pageviews, p.visitors]);
			name = `facet-series-${start}-${end}`;
		} else if (kind === 'breakdown') {
			const dimension = c.req.query('dimension') ?? '';
			// IMPORTANT: own-property only — `toString`/`constructor`/`valueOf` are truthy on an
			// object literal and would reach the loader instead of this 400.
			const load = Object.hasOwn(EXPORT_DIMENSIONS, dimension)
				? EXPORT_DIMENSIONS[dimension]
				: undefined;
			if (!load) {
				throw new ApiError('bad_request', 400, 'unknown or missing dimension');
			}
			const limitRaw = c.req.query('limit');
			if (limitRaw !== undefined) {
				const limit = Number(limitRaw);
				if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_MAX_ROWS) {
					throw new ApiError('bad_request', 400, `limit must be 1..${EXPORT_MAX_ROWS}`);
				}
			}
			const limit = limitRaw !== undefined ? Number(limitRaw) : 100;
			const data = (await load(c.env, f)).slice(0, limit);
			columns = ['key', 'count'];
			rows = data.map((r) => [r.key, r.count]);
			name = `facet-${dimension}-${start}-${end}`;
		} else {
			throw new ApiError('bad_request', 400, 'kind must be series or breakdown');
		}

		const origin = new URL(c.req.url).origin;
		const isJson = format === 'json';
		const bodyText = isJson ? JSON.stringify({ columns, rows }) : toCsv(columns, rows);
		const contentType = isJson ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8';
		const loadingKey = getSigningKey(c.env);
		const key = loadingKey ? await loadingKey : null;

		// Signed-envelope mode: a self-contained, offline-verifiable JSON export (detached JWS over the
		// canonical payload + embedded public JWK). Requires a configured signing key.
		if (c.req.query('sign') === '1') {
			if (!key) {
				throw new ApiError(
					'signing_unavailable',
					501,
					'deployment signing key not configured',
				);
			}
			return c.json(
				await signExport({ columns, rows }, key, {
					jwksUrl: jwksUrl(origin),
					now: Date.now(),
				}),
			);
		}

		const headers: Record<string, string> = { 'content-type': contentType };
		if (!isJson) {
			headers['content-disposition'] = `attachment; filename="${name}.csv"`;
		}
		// When signing is configured, offer BOTH integrity options over the exact response bytes: a
		// detached JWS (Facet-Signature-Jws) and an RFC 9421 Signature/Signature-Input pair.
		if (key) {
			const bodyBytes = new TextEncoder().encode(bodyText);
			const sig = await signResponse({
				body: bodyBytes,
				contentType,
				created: Math.floor(Date.now() / 1000),
				key,
			});
			headers['content-digest'] = sig['content-digest'];
			headers['signature-input'] = sig['signature-input'];
			headers.signature = sig.signature;
			headers['facet-signature-jws'] = await signDetachedJws(bodyBytes, key);
			headers['facet-signing-key'] = jwksUrl(origin);
		}
		return new Response(bodyText, { headers });
	},
);

// Signed AnalyticsReportCredential (VC 2.0, eddsa-jcs-2022) over an aggregate stats snapshot for a
// site+range. The credential subject is the DATASET (`<origin>/sites/<id>`), never a person. Requires
// an Ed25519 signing key; 501 when unconfigured.
statsRoutes.get('/stats/report', requireSiteAccess, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	const start = Number(c.req.query('start'));
	const end = Number(c.req.query('end'));
	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		throw new ApiError('bad_range', 400);
	}
	assertRange(start, end);
	const r = await loadEd25519Key(c.env);
	if ('error' in r) {
		throw new ApiError(
			ed25519KeyErrorCode(r.error, {
				unconfigured: 'signing_unavailable',
				notEd25519: 'report_requires_ed25519',
			}),
			501,
		);
	}
	const key = r.key;

	const url = new URL(c.req.url);
	const did = deploymentDid(url);
	if (!did) throw new ApiError('did_unavailable', 501);
	const created = new Date().toISOString();
	const s = await summary(c.env, { siteId, start, end });
	const doc = buildAnalyticsReportCredential({
		did,
		created,
		site: siteId,
		subjectId: `${url.origin}/sites/${siteId}`,
		range: { start, end },
		report: {
			pageviews: s.pageviews,
			visitors: s.visitors,
			events: s.events,
		},
	});
	const vc = await issueCredential(doc, key, {
		verificationMethod: verificationMethodId(did, key.kid),
		created,
	});
	return c.json(vc, 200, { 'content-type': 'application/vc+json' });
});

statsRoutes.get(
	'/stats/anomalies',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		return c.json({
			anomalies: await detectAnomalies(c.env, f, Date.now()),
		});
	},
);

// Natural-language analytics query: translate a plain-English question into a constrained intent
// (via Workers AI) and execute it over the aggregate helpers. Aggregate-only, no identity.
statsRoutes.post('/stats/query', requireSiteAccess, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		site_id?: unknown;
		question?: unknown;
		start?: unknown;
		end?: unknown;
	};
	if (body.site_id !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	if (
		typeof body.question !== 'string' ||
		body.question.length === 0 ||
		body.question.length > 500
	) {
		throw new ApiError('bad_request', 400);
	}
	const start = Number(body.start);
	const end = Number(body.end);
	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		throw new ApiError('bad_range', 400);
	}
	assertRange(start, end);
	if (!c.env.AI) {
		return c.json({ error: 'ai_unavailable' }, 503);
	}
	const siteId = c.get('siteId');
	const f = { siteId, start, end };
	return c.json(await answerQuestion(c.env, aiRunner(c.env), siteId, body.question, f));
});

statsRoutes.get('/stats/conversions', requireSiteAccess, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	const start = Number(c.req.query('start'));
	const end = Number(c.req.query('end'));
	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		throw new ApiError('bad_range', 400);
	}
	assertRange(start, end);
	const goal = await getGoalById(c.env, c.req.query('goal_id') ?? '');
	if (!goal || goal.site_id !== siteId) {
		return c.json({ error: 'not_found' }, 404);
	}
	const result = await goalConversions(c.env, siteId, goal, {
		siteId,
		start,
		end,
	});
	return c.json({
		goal_id: goal.id,
		conversions: result.conversions,
		sessions: result.sessions,
		rate: result.rate,
	});
});

// API-key-scoped catalog reads so the dashboard can enumerate a site's goals/funnels (config, not
// PII) without the admin token. Creation/deletion remain admin-only.
statsRoutes.get('/stats/goals', requireSiteAccess, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	return c.json({ goals: await listGoals(c.env, siteId) });
});

statsRoutes.get('/stats/funnels', requireSiteAccess, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	return c.json({ funnels: await listFunnels(c.env, siteId) });
});

statsRoutes.get('/stats/experiments', requireSiteAccess, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	return c.json({ experiments: await listExperiments(c.env, siteId) });
});

statsRoutes.get('/stats/experiment', requireSiteAccess, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	const start = Number(c.req.query('start'));
	const end = Number(c.req.query('end'));
	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		throw new ApiError('bad_range', 400);
	}
	assertRange(start, end);
	const goalType = c.req.query('goal_type');
	if (goalType !== 'event' && goalType !== 'path') {
		throw new ApiError('bad_goal', 400);
	}
	const goalValue = c.req.query('goal_value') ?? '';
	if (goalValue.length === 0) {
		throw new ApiError('bad_goal', 400);
	}
	const experiments = await listExperiments(c.env, siteId);
	const experiment = experiments.find((e) => e.id === (c.req.query('experiment_id') ?? ''));
	if (!experiment) {
		return c.json({ error: 'not_found' }, 404);
	}
	const result = await experimentResult(
		c.env,
		experiment,
		{ type: goalType, value: goalValue },
		{ siteId, start, end },
	);
	return c.json(result);
});

// GET /api/stats/digest — the whole site in one compact markdown block, for machine readers.
//
// An LLM agent working on a site wants "how is this doing" in one cheap call. Answering that from
// /api/stats means shipping a large JSON document and paying to re-parse a schema on every turn, and
// answering it from a feed would be worse still (see lib/digest.ts for why RSS is the wrong shape).
// This composes the same helpers /api/stats uses and renders them to markdown, which is close to the
// token floor for tabular data and needs no schema sent alongside it.
//
// Same API-key auth, same site ownership check, and the same 90-day range cap as every other read.
statsRoutes.get(
	'/stats/digest',
	requireSiteAccess,
	rateLimit((c) => `stats-digest:${c.get('siteId')}`),
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const f = toStatsFilter(query, c.get('siteId'));
		// The equal-length window immediately before this one, so every headline metric carries a
		// delta. An agent asking "how is this doing" almost always means "compared to what".
		const span = f.end - f.start;
		const previousFilter: StatsFilter = { ...f, start: f.start - span, end: f.start };

		const [
			site,
			summaryResult,
			previousResult,
			engagementResult,
			paths,
			referrers,
			countries,
			devices,
			channelsResult,
			anomalies,
			freshness,
		] = await Promise.all([
			getSiteMeta(c.env, f.siteId),
			summary(c.env, f),
			summary(c.env, previousFilter),
			engagement(c.env, f),
			topPaths(c.env, f),
			topReferrers(c.env, f),
			topCountries(c.env, f),
			topDevices(c.env, f),
			channels(c.env, f),
			detectAnomalies(c.env, f, Date.now()),
			sessionFreshness(c.env, f),
		]);

		const markdown = renderDigest({
			siteName: site?.name ?? 'Site',
			siteDomain: site?.domain ?? '',
			start: f.start,
			end: f.end,
			summary: summaryResult,
			previous: previousResult,
			engagement: engagementResult,
			topPaths: paths,
			topReferrers: referrers,
			topCountries: countries,
			topDevices: devices,
			channels: channelsResult,
			anomalies,
			sessionsPending: freshness.pending,
		});

		return c.body(markdown, 200, {
			'content-type': 'text/markdown; charset=utf-8',
			'cache-control': 'no-store',
			// This body interpolates attacker-controlled text (paths and referrers come from the
			// public beacon), so it must never be sniffed into text/html by a consumer.
			'x-content-type-options': 'nosniff',
		});
	},
);
