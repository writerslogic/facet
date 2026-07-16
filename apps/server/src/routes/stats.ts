// GET /api/stats — API-key authenticated read endpoint. Validates the range, enforces that the key
// owns the requested site, and assembles the full stats response from the T021 helpers.

import { type Goal, StatsQuerySchema, type StatsResponse } from '@countless/shared';
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
	series,
	summary,
	topCountries,
	topDevices,
	topEvents,
	topPaths,
	topReferrers,
} from '../db/stats.js';
import type { AppEnv } from '../env.js';
import { requireApiKey } from '../lib/auth.js';
import { DAY_MS, HOUR_MS, MAX_RANGE_DAYS } from '../lib/constants.js';
import { ApiError } from '../lib/http.js';

export const statsRoutes = new Hono<AppEnv>();

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
		if (query.site_id !== c.get('siteId')) {
			throw new ApiError('site_mismatch', 403);
		}
		if (query.end <= query.start) {
			throw new ApiError('bad_range', 400);
		}
		if (query.end - query.start > MAX_RANGE_DAYS * DAY_MS) {
			throw new ApiError('range_too_large', 400);
		}
		const interval =
			query.interval ?? (query.end - query.start <= 48 * HOUR_MS ? 'hour' : 'day');
		const f = {
			siteId: query.site_id,
			hostname: query.hostname,
			start: query.start,
			end: query.end,
		};
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
		const query = c.req.valid('query');
		if (query.site_id !== c.get('siteId')) {
			throw new ApiError('site_mismatch', 403);
		}
		if (query.end <= query.start) {
			throw new ApiError('bad_range', 400);
		}
		if (query.end - query.start > MAX_RANGE_DAYS * DAY_MS) {
			throw new ApiError('range_too_large', 400);
		}
		const f = {
			siteId: query.site_id,
			hostname: query.hostname,
			start: query.start,
			end: query.end,
		};
		return c.json({ engagement: await engagement(c.env, f) });
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
		const query = c.req.valid('query');
		if (query.site_id !== c.get('siteId')) {
			throw new ApiError('site_mismatch', 403);
		}
		if (query.end <= query.start) {
			throw new ApiError('bad_range', 400);
		}
		if (query.end - query.start > MAX_RANGE_DAYS * DAY_MS) {
			throw new ApiError('range_too_large', 400);
		}
		const f = {
			siteId: query.site_id,
			hostname: query.hostname,
			start: query.start,
			end: query.end,
		};
		return c.json({ channels: await channels(c.env, f) });
	},
);

statsRoutes.get(
	'/stats/anomalies',
	requireApiKey,
	vValidator('query', StatsQuerySchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const query = c.req.valid('query');
		if (query.site_id !== c.get('siteId')) {
			throw new ApiError('site_mismatch', 403);
		}
		if (query.end <= query.start) {
			throw new ApiError('bad_range', 400);
		}
		if (query.end - query.start > MAX_RANGE_DAYS * DAY_MS) {
			throw new ApiError('range_too_large', 400);
		}
		const f = {
			siteId: query.site_id,
			hostname: query.hostname,
			start: query.start,
			end: query.end,
		};
		return c.json({ anomalies: await detectAnomalies(c.env, f) });
	},
);

statsRoutes.get('/stats/conversions', requireApiKey, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	const start = Number(c.req.query('start'));
	const end = Number(c.req.query('end'));
	if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
		throw new ApiError('bad_range', 400);
	}
	if (end - start > MAX_RANGE_DAYS * DAY_MS) {
		throw new ApiError('range_too_large', 400);
	}
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
	if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
		throw new ApiError('bad_range', 400);
	}
	if (end - start > MAX_RANGE_DAYS * DAY_MS) {
		throw new ApiError('range_too_large', 400);
	}
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
