// GET /api/stats and related read endpoints — API-key authenticated. Returns pageviews,
// uniques, top paths/referrers, and custom-event counts. Logic lands in T017; wiring stub.

import { Hono } from 'hono';
import type { Env } from '../env.js';

export const statsRoutes = new Hono<{ Bindings: Env }>();

statsRoutes.get('/stats', (c) => {
	return c.json({
		summary: { pageviews: 0, visitors: 0, events: 0 },
		series: [],
		top_paths: [],
		top_referrers: [],
		top_events: [],
	});
});
