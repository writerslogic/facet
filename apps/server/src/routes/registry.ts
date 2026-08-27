// Route table. `app.ts` iterates `ROUTES` to mount every sub-router; new routes append an entry
// here rather than editing `app.ts`. Health lives here too, as the smallest router.

import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAdmin } from '../lib/auth.js';
import { adminRoutes } from './admin.js';
import { alertsRoutes } from './alerts.js';
import { attestationRoutes } from './attestation.js';
import { authRoutes } from './auth.js';
import { collectRoute } from './collect.js';
import { consentRoutes } from './consent.js';
import { crmRoutes } from './crm.js';
import { eventRoute } from './event.js';
import { experimentsRoutes } from './experiments.js';
import { flagsRoutes } from './flags.js';
import { funnelsRoutes } from './funnels.js';
import { goalsRoutes } from './goals.js';
import { importRoutes } from './import.js';
import { llmsRoutes } from './llms.js';
import { mcpRoutes } from './mcp.js';
import { scittRoutes } from './scitt.js';
import { statsRoutes } from './stats.js';
import { transparencyRoutes } from './transparency.js';
import { wellKnownRoutes } from './wellknown.js';

const healthRoute = new Hono<AppEnv>();
healthRoute.get('/', (c) => c.json({ ok: true }));

// Authenticated readiness is intentionally deeper than public liveness: it proves D1 is reachable
// and reports missing production controls without exposing deployment configuration anonymously.
const readinessRoute = new Hono<AppEnv>();
readinessRoute.get('/', requireAdmin, async (c) => {
	const checks: Record<string, boolean> = {
		database: false,
		rateLimiter: Boolean(c.env.RATE_LIMITER),
		queue: Boolean(c.env.INGEST_QUEUE),
		adminToken: Boolean(c.env.ADMIN_TOKEN),
		retention: /^\d+$/.test(c.env.RAW_RETENTION_DAYS ?? ''),
	};
	try {
		await c.env.DB.prepare('SELECT 1').first();
		checks.database = true;
	} catch {
		checks.database = false;
	}
	const required = ['database', 'rateLimiter', 'adminToken', 'retention'];
	const ok = required.every((name) => checks[name]);
	let jobResults: unknown[] = [];
	if (checks.database) {
		try {
			const jobs = await c.env.DB.prepare(
				// IMPORTANT: cadence_error must be selected — a job disabled by a malformed cadence never
				// runs and so never records a failure, making it invisible on every other column here.
				'SELECT name, last_success_at, last_failure_at, last_error, last_occurrence, cadence_error FROM scheduled_job_runs ORDER BY name',
			).all();
			jobResults = jobs.results;
			const integrity = await c.env.DB.prepare(`
				SELECT
					(SELECT COUNT(*) FROM events e LEFT JOIN sites s ON s.site_id = e.site_id WHERE s.site_id IS NULL) +
					(SELECT COUNT(*) FROM api_keys k LEFT JOIN sites s ON s.site_id = k.site_id WHERE s.site_id IS NULL) +
					(SELECT COUNT(*) FROM event_rollups r LEFT JOIN sites s ON s.site_id = r.site_id WHERE s.site_id IS NULL)
					AS violations
			`).first<{ violations: number }>();
			checks.referentialIntegrity = integrity?.violations === 0;
		} catch {
			checks.migrations = false;
		}
	}
	if (checks.migrations === undefined) checks.migrations = true;
	const ready = ok && checks.migrations && checks.referentialIntegrity !== false;
	return c.json({ ok: ready, checks, scheduled_jobs: jobResults }, ready ? 200 : 503);
});

/** A sub-router and the base path it mounts under. */
export interface RouteEntry {
	path: string;
	router: Hono<AppEnv>;
}

export const ROUTES: RouteEntry[] = [
	{ path: '/.well-known', router: wellKnownRoutes },
	{ path: '/llms.txt', router: llmsRoutes },
	{ path: '/api/health', router: healthRoute },
	{ path: '/api/ready', router: readinessRoute },
	{ path: '/api/mcp', router: mcpRoutes },
	{ path: '/api/collect', router: collectRoute },
	{ path: '/api/auth', router: authRoutes },
	{ path: '/api/event', router: eventRoute },
	{ path: '/api/consent', router: consentRoutes },
	// Optional extension: every route 501s unless CRM_DB is bound. Mounted unconditionally so the
	// answer is a deliberate "this deployment does not implement it", not a 404 that looks like a bug.
	{ path: '/api/crm', router: crmRoutes },
	{ path: '/api', router: statsRoutes },
	{ path: '/api', router: adminRoutes },
	{ path: '/api/goals', router: goalsRoutes },
	{ path: '/api/import', router: importRoutes },
	{ path: '/api/funnels', router: funnelsRoutes },
	{ path: '/api/experiments', router: experimentsRoutes },
	{ path: '/api/flags', router: flagsRoutes },
	{ path: '/api/alerts', router: alertsRoutes },
	{ path: '/api/attestation', router: attestationRoutes },
	{ path: '/api/transparency', router: transparencyRoutes },
	{ path: '/api/scitt', router: scittRoutes },
];
