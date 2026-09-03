// Route table. `app.ts` iterates `ROUTES` to mount every sub-router; new routes append an entry
// here rather than editing `app.ts`. Health lives here too, as the smallest router.

import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { analyticsSliceRoutes } from '../features/analytics/slices.js';
import { requireAdmin } from '../lib/auth.js';
import { adminRoutes } from './admin.js';
import { alertsRoutes } from './alerts.js';
import { annotationsRoutes } from './annotations.js';
import { attestationRoutes } from './attestation.js';
import { authRoutes } from './auth.js';
import { collectRoute } from './collect.js';
import { consentRoutes } from './consent.js';
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
		} catch {
			checks.migrations = false;
		}
		try {
			// IMPORTANT: `sites` keys on `id`, not `site_id`. Joining `s.site_id` made this fail to prepare,
			// and one shared catch reported that as `migrations: false` on every healthy deployment; hence
			// the separate catch. EXISTS, not summed COUNT(*)s, so a violation stops at the first orphan row.
			const integrity = await c.env.DB.prepare(`
				SELECT
					(EXISTS(SELECT 1 FROM sites s LEFT JOIN teams t ON t.id = s.team_id
						WHERE s.team_id IS NOT NULL AND t.id IS NULL)
						OR EXISTS(SELECT 1 FROM memberships m LEFT JOIN teams t ON t.id = m.team_id
							WHERE t.id IS NULL)
						OR EXISTS(SELECT 1 FROM memberships m LEFT JOIN users u ON u.id = m.user_id
							WHERE u.id IS NULL)
						OR EXISTS(SELECT 1 FROM events e LEFT JOIN sites s ON s.id = e.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM event_rollups r LEFT JOIN sites s ON s.id = r.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM sessions x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM event_sessions x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM api_keys k LEFT JOIN sites s ON s.id = k.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM api_key_scopes x LEFT JOIN api_keys k ON k.id = x.api_key_id
							WHERE k.id IS NULL)
						OR EXISTS(SELECT 1 FROM goals x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM funnels x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM experiments x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM flags x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM site_config x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM consent_records x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM timeline_annotations x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM alert_destinations x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM metric_alert_rules x LEFT JOIN sites s ON s.id = x.site_id
							WHERE s.id IS NULL)
						OR EXISTS(SELECT 1 FROM alert_deliveries x
							LEFT JOIN alert_destinations d ON d.id = x.destination_id
							LEFT JOIN sites s ON s.id = x.site_id
							WHERE d.id IS NULL OR s.id IS NULL))
					AS violations
			`).first<{ violations: number }>();
			checks.referentialIntegrity = integrity?.violations === 0;
		} catch {
			checks.referentialIntegrity = false;
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
	{ path: '/api', router: analyticsSliceRoutes },
	{ path: '/api', router: statsRoutes },
	{ path: '/api', router: adminRoutes },
	{ path: '/api/goals', router: goalsRoutes },
	{ path: '/api/import', router: importRoutes },
	{ path: '/api/funnels', router: funnelsRoutes },
	{ path: '/api/experiments', router: experimentsRoutes },
	{ path: '/api/flags', router: flagsRoutes },
	{ path: '/api/alerts', router: alertsRoutes },
	{ path: '/api/annotations', router: annotationsRoutes },
	{ path: '/api/attestation', router: attestationRoutes },
	{ path: '/api/transparency', router: transparencyRoutes },
	{ path: '/api/scitt', router: scittRoutes },
];
