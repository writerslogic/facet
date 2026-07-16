// Canonical route table. `app.ts` iterates `ROUTES` to mount every sub-router, so a new route
// task appends one entry here and never edits `app.ts` (this removes the app.ts serialization
// chain — see the DRY mandate). Health lives here too, as the smallest router.

import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { adminRoutes } from './admin.js';
import { collectRoute } from './collect.js';
import { eventRoute } from './event.js';
import { funnelsRoutes } from './funnels.js';
import { goalsRoutes } from './goals.js';
import { statsRoutes } from './stats.js';

const healthRoute = new Hono<AppEnv>();
healthRoute.get('/', (c) => c.json({ ok: true }));

/** A sub-router and the base path it mounts under. */
export interface RouteEntry {
	path: string;
	router: Hono<AppEnv>;
}

export const ROUTES: RouteEntry[] = [
	{ path: '/api/health', router: healthRoute },
	{ path: '/api/collect', router: collectRoute },
	{ path: '/api/event', router: eventRoute },
	{ path: '/api', router: statsRoutes },
	{ path: '/api', router: adminRoutes },
	{ path: '/api/goals', router: goalsRoutes },
	{ path: '/api/funnels', router: funnelsRoutes },
];
