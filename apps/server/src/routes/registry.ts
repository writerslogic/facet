// Route table. `app.ts` iterates `ROUTES` to mount every sub-router; new routes append an entry
// here rather than editing `app.ts`. Health lives here too, as the smallest router.

import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { adminRoutes } from './admin.js';
import { alertsRoutes } from './alerts.js';
import { attestationRoutes } from './attestation.js';
import { authRoutes } from './auth.js';
import { collectRoute } from './collect.js';
import { consentRoutes } from './consent.js';
import { eventRoute } from './event.js';
import { experimentsRoutes } from './experiments.js';
import { flagsRoutes } from './flags.js';
import { funnelsRoutes } from './funnels.js';
import { goalsRoutes } from './goals.js';
import { llmsRoutes } from './llms.js';
import { mcpRoutes } from './mcp.js';
import { scittRoutes } from './scitt.js';
import { statsRoutes } from './stats.js';
import { transparencyRoutes } from './transparency.js';
import { wellKnownRoutes } from './wellknown.js';

const healthRoute = new Hono<AppEnv>();
healthRoute.get('/', (c) => c.json({ ok: true }));

/** A sub-router and the base path it mounts under. */
export interface RouteEntry {
	path: string;
	router: Hono<AppEnv>;
}

export const ROUTES: RouteEntry[] = [
	{ path: '/.well-known', router: wellKnownRoutes },
	{ path: '/llms.txt', router: llmsRoutes },
	{ path: '/api/health', router: healthRoute },
	{ path: '/api/mcp', router: mcpRoutes },
	{ path: '/api/collect', router: collectRoute },
	{ path: '/api/auth', router: authRoutes },
	{ path: '/api/event', router: eventRoute },
	{ path: '/api/consent', router: consentRoutes },
	{ path: '/api', router: statsRoutes },
	{ path: '/api', router: adminRoutes },
	{ path: '/api/goals', router: goalsRoutes },
	{ path: '/api/funnels', router: funnelsRoutes },
	{ path: '/api/experiments', router: experimentsRoutes },
	{ path: '/api/flags', router: flagsRoutes },
	{ path: '/api/alerts', router: alertsRoutes },
	{ path: '/api/attestation', router: attestationRoutes },
	{ path: '/api/transparency', router: transparencyRoutes },
	{ path: '/api/scitt', router: scittRoutes },
];
