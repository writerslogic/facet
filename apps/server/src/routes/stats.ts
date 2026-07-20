// GET /api/stats — API-key authenticated read endpoint. Validates the range, enforces that the key
// owns the requested site, and assembles the full stats response.

import {
	type CountRow,
	type Goal,
	type StatsFilter,
	type StatsQueryInput,
	StatsQuerySchema,
	type StatsResponse,
} from '@facet/shared';
import {
	buildAnalyticsReportCredential,
	didWebFromHost,
	issueCredential,
	signDetachedJws,
	signExport,
	signResponse,
	verificationMethodId,
} from '@facet/trust';
import { vValidator } from '@hono/valibot-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { detectAnomalies } from '../db/anomaly.js';
import { listExperiments, listFunnels, listGoals } from '../db/catalog.js';
import { goalConversions } from '../db/conversions.js';
import { experimentResult } from '../db/experiments.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import {
	channels,
	engagement,
	realtime,
	series,
	sessionFreshness,
	summary,
	topCountries,
	topDevices,
	topEvents,
	topInteractions,
	topPaths,
	topReferrers,
} from '../db/stats.js';
import type { AppEnv } from '../env.js';
import { aiRunner, answerQuestion } from '../lib/ai.js';
import { requireApiKey } from '../lib/auth.js';
import {
	DAY_MS,
	EXPORT_MAX_ROWS,
	HOUR_MS,
	MAX_RANGE_DAYS,
	REALTIME_WINDOW_MS,
} from '../lib/constants.js';
import { toCsv } from '../lib/csv.js';
import { ApiError } from '../lib/http.js';
import { getSigningKey, jwksUrl, loadEd25519Key } from '../lib/signing.js';

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
	};
}

statsRoutes.get(
	'/stats',
	requireApiKey,
	vValidator('query', StatsQuerySchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const query = c.req.valid('query');
		const f = toStatsFilter(query, c.get('siteId'));
		const interval =
			query.interval ?? (query.end - query.start <= 48 * HOUR_MS ? 'hour' : 'day');
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
			meta: freshness,
		};
		return c.json(body);
	},
);

statsRoutes.get(
	'/stats/sessions',
	requireApiKey,
	vValidator('query', StatsQuerySchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		return c.json({
			engagement: await engagement(c.env, f),
			meta: await sessionFreshness(c.env, f),
		});
	},
);

statsRoutes.get(
	'/stats/channels',
	requireApiKey,
	vValidator('query', StatsQuerySchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		return c.json({
			channels: await channels(c.env, f),
			meta: await sessionFreshness(c.env, f),
		});
	},
);

// Internal/system interactions ($exposure, form_submit, other $-prefixed) shown separately from
// marketer-facing custom events, which exclude them.
statsRoutes.get(
	'/stats/interactions',
	requireApiKey,
	vValidator('query', StatsQuerySchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		return c.json({ interactions: await topInteractions(c.env, f) });
	},
);

// Realtime snapshot: active-visitor proxy (distinct daily hashes) + pageviews over the last few
// minutes. Privacy-safe (no cookies/ids), bounded window, indexed by created_at.
statsRoutes.get('/stats/realtime', requireApiKey, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	return c.json(await realtime(c.env, siteId, Date.now(), REALTIME_WINDOW_MS));
});

// Authenticated read-only export of a series or a breakdown as CSV or JSON. Same site-scoping and
// range validation as the other stats reads; output is bounded (series by range, breakdown by limit)
// and CSV cells are formula-injection-safe.
type ExportFilter = { siteId: string; start: number; end: number };
const EXPORT_DIMENSIONS: Record<
	string,
	(env: AppEnv['Bindings'], f: ExportFilter) => Promise<CountRow[]>
> = {
	path: (env, f) => topPaths(env, f, EXPORT_MAX_ROWS),
	referrer: (env, f) => topReferrers(env, f, EXPORT_MAX_ROWS),
	country: (env, f) => topCountries(env, f, EXPORT_MAX_ROWS),
	device: (env, f) => topDevices(env, f),
	event: (env, f) => topEvents(env, f, EXPORT_MAX_ROWS),
	channel: (env, f) => channels(env, f),
};

statsRoutes.get('/stats/export', requireApiKey, async (c) => {
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
	const format = c.req.query('format') ?? 'csv';
	if (format !== 'csv' && format !== 'json') {
		throw new ApiError('bad_request', 400, 'format must be csv or json');
	}
	const kind = c.req.query('kind') ?? 'series';
	const f = { siteId, start, end };

	let columns: string[];
	let rows: (string | number)[][];
	let name: string;

	if (kind === 'series') {
		const q = c.req.query('interval');
		const interval =
			q === 'hour' || q === 'day' ? q : end - start <= 48 * HOUR_MS ? 'hour' : 'day';
		const points = await series(c.env, f, interval);
		columns = ['bucket_start_iso', 'bucket_start_ms', 'pageviews', 'visitors'];
		rows = points.map((p) => [new Date(p.t).toISOString(), p.t, p.pageviews, p.visitors]);
		name = `facet-series-${start}-${end}`;
	} else if (kind === 'breakdown') {
		const dimension = c.req.query('dimension') ?? '';
		const load = EXPORT_DIMENSIONS[dimension];
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
			throw new ApiError('signing_unavailable', 501, 'deployment signing key not configured');
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
});

// Signed AnalyticsReportCredential (VC 2.0, eddsa-jcs-2022) over an aggregate stats snapshot for a
// site+range. The credential subject is the DATASET (`<origin>/sites/<id>`), never a person. Requires
// an Ed25519 signing key; 501 when unconfigured.
statsRoutes.get('/stats/report', requireApiKey, async (c) => {
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
			r.error === 'unconfigured' ? 'signing_unavailable' : 'report_requires_ed25519',
			501,
		);
	}
	const key = r.key;

	const url = new URL(c.req.url);
	const did = didWebFromHost(url.host);
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
	requireApiKey,
	vValidator('query', StatsQuerySchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const f = toStatsFilter(c.req.valid('query'), c.get('siteId'));
		return c.json({
			anomalies: await detectAnomalies(c.env, f, Date.now()),
		});
	},
);

// Natural-language analytics query: translate a plain-English question into a constrained intent
// (via Workers AI) and execute it over the aggregate helpers. Aggregate-only, no identity.
statsRoutes.post('/stats/query', requireApiKey, async (c) => {
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

statsRoutes.get('/stats/conversions', requireApiKey, async (c) => {
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
	const row = await db(c.env)
		.select()
		.from(schema.goals)
		.where(eq(schema.goals.id, c.req.query('goal_id') ?? ''))
		.get();
	if (!row || row.site_id !== siteId) {
		return c.json({ error: 'not_found' }, 404);
	}
	const goal: Goal = {
		id: row.id,
		site_id: row.site_id,
		name: row.name,
		type: row.type as Goal['type'],
		match_value: row.match_value,
		created_at: row.created_at,
	};
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
statsRoutes.get('/stats/goals', requireApiKey, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	return c.json({ goals: await listGoals(c.env, siteId) });
});

statsRoutes.get('/stats/funnels', requireApiKey, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	return c.json({ funnels: await listFunnels(c.env, siteId) });
});

statsRoutes.get('/stats/experiments', requireApiKey, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	return c.json({ experiments: await listExperiments(c.env, siteId) });
});

statsRoutes.get('/stats/experiment', requireApiKey, async (c) => {
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
