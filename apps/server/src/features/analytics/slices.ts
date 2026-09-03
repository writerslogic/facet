import { StatsQuerySchema } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { Hono } from 'hono';
import {
	acquisitionStats,
	attributionStats,
	contentStats,
	coreStats,
	engagementStats,
	freshnessStats,
	realtimeContext,
	revenueStats,
	summaryStats,
	technologyStats,
} from '../../db/stats.js';
import type { AppEnv } from '../../env.js';
import { requireSiteAccess } from '../../lib/auth.js';
import { validationErrorHook } from '../../lib/http.js';
import { statsFilter, statsInterval } from './query.js';
import { recordStatsRead } from './telemetry.js';

export const analyticsSliceRoutes = new Hono<AppEnv>();

// Narrow compatibility-preserving reads. These are intentionally separate routes rather than a
// `fields=` switch: each has a stable response contract, a bounded query plan, and a cache key that
// says what work it causes. Multi-statement plans use D1 batch and retain `rows_read` telemetry.
analyticsSliceRoutes.get(
	'/stats/core',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const read = await coreStats(
			c.env,
			statsFilter(query, c.get('siteId')),
			statsInterval(query),
		);
		recordStatsRead('core', read.metrics);
		return c.json(read.data);
	},
);

analyticsSliceRoutes.get(
	'/stats/summary',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const read = await summaryStats(c.env, statsFilter(c.req.valid('query'), c.get('siteId')));
		recordStatsRead('summary', read.metrics);
		return c.json(read.data);
	},
);

analyticsSliceRoutes.get(
	'/stats/freshness',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const read = await freshnessStats(
			c.env,
			statsFilter(c.req.valid('query'), c.get('siteId')),
		);
		recordStatsRead('freshness', read.metrics);
		return c.json(read.data);
	},
);

analyticsSliceRoutes.get(
	'/stats/realtime-context',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const read = await realtimeContext(
			c.env,
			statsFilter(c.req.valid('query'), c.get('siteId')),
		);
		recordStatsRead('realtime_context', read.metrics);
		return c.json(read.data);
	},
);

analyticsSliceRoutes.get(
	'/stats/content',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const read = await contentStats(c.env, statsFilter(c.req.valid('query'), c.get('siteId')));
		recordStatsRead('content', read.metrics);
		return c.json(read.data);
	},
);

analyticsSliceRoutes.get(
	'/stats/acquisition',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const read = await acquisitionStats(
			c.env,
			statsFilter(c.req.valid('query'), c.get('siteId')),
		);
		recordStatsRead('acquisition', read.metrics);
		return c.json(read.data);
	},
);

analyticsSliceRoutes.get(
	'/stats/technology',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const read = await technologyStats(
			c.env,
			statsFilter(c.req.valid('query'), c.get('siteId')),
		);
		recordStatsRead('technology', read.metrics);
		return c.json(read.data);
	},
);

analyticsSliceRoutes.get(
	'/stats/engagement',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const read = await engagementStats(
			c.env,
			statsFilter(c.req.valid('query'), c.get('siteId')),
		);
		recordStatsRead('engagement', read.metrics);
		return c.json(read.data);
	},
);

analyticsSliceRoutes.get(
	'/stats/revenue',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const read = await revenueStats(c.env, statsFilter(c.req.valid('query'), c.get('siteId')));
		recordStatsRead('revenue', read.metrics);
		return c.json(read.data);
	},
);

analyticsSliceRoutes.get(
	'/stats/attribution',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const read = await attributionStats(
			c.env,
			statsFilter(c.req.valid('query'), c.get('siteId')),
		);
		recordStatsRead('attribution', read.metrics);
		return c.json(read.data);
	},
);
