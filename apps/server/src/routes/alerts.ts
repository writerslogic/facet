// Alert destinations + metric rules: admin CRUD following the goals/funnels site-scoping contract,
// with valibot-validated bodies and the canonical ApiError envelope.
//
// Not built on crudRouter because two things here are not a verbatim insert of the validated body:
// the webhook target is re-validated against the SSRF policy, and a webhook destination is issued a
// signing secret that is returned exactly once and never again.

import {
	type AlertDestination,
	AlertDestinationSchema,
	type AlertSeverity,
	type MetricAlertMetric,
	type MetricAlertOperator,
	type MetricAlertRule,
	MetricAlertRuleSchema,
} from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { requireAdmin } from '../lib/auth.js';
import { randomHex } from '../lib/crypto.js';
import { ApiError, validationErrorHook } from '../lib/http.js';
import { checkWebhookUrl } from '../lib/notify.js';

/** Bytes of entropy in a webhook signing secret (rendered as hex), matching the API-key convention. */
const ALERT_SECRET_BYTES = 32 as const;

export const alertsRoutes = new Hono<AppEnv>();

// Admin-only, for the whole router. Alert configuration decides where a deployment's data is sent,
// so a site API key must never reach it — every route below is behind ADMIN_TOKEN.
alertsRoutes.use('*', requireAdmin);

const EmailTargetSchema = v.pipe(v.string(), v.email(), v.maxLength(254));

/** Public view of a stored row. The `secret` column is deliberately absent. */
function toPublic(row: typeof schema.alertDestinations.$inferSelect): AlertDestination {
	return {
		id: row.id,
		site_id: row.site_id,
		name: row.name,
		type: row.type as AlertDestination['type'],
		target: row.target,
		min_severity: row.min_severity as AlertSeverity,
		enabled: row.enabled === 1,
		created_at: row.created_at,
	};
}

/** Public view of an immutable threshold rule. The fixed one-hour window is explicit even though it
 * is not stored: a caller should never have to infer what period the threshold applies to. */
function toPublicRule(row: typeof schema.metricAlertRules.$inferSelect): MetricAlertRule {
	return {
		id: row.id,
		site_id: row.site_id,
		name: row.name,
		metric: row.metric as MetricAlertMetric,
		operator: row.operator as MetricAlertOperator,
		threshold: row.threshold,
		severity: row.severity as AlertSeverity,
		enabled: row.enabled === 1,
		window_minutes: 60,
		created_at: row.created_at,
	};
}

alertsRoutes.post(
	'/',
	vValidator('json', AlertDestinationSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		if (body.type === 'webhook') {
			const rejection = checkWebhookUrl(body.target);
			if (rejection) {
				// The reason is a fixed code, never the submitted URL — errors do not echo input back.
				throw new ApiError('invalid_webhook_url', 400, rejection);
			}
		} else if (!v.is(EmailTargetSchema, body.target)) {
			throw new ApiError('invalid_email_target', 400);
		}
		// Webhook payloads are HMAC-signed under a per-destination secret. It is generated here and
		// returned ONCE; the list endpoint never discloses it, so an operator who loses it deletes the
		// destination and creates a new one (same handling as an API key).
		const secret = body.type === 'webhook' ? randomHex(ALERT_SECRET_BYTES) : null;
		const row = {
			id: crypto.randomUUID(),
			site_id: body.site_id,
			name: body.name,
			type: body.type,
			target: body.target,
			min_severity: body.min_severity ?? 'warning',
			secret,
			enabled: body.enabled === false ? 0 : 1,
			created_at: Date.now(),
		};
		await db(c.env).insert(schema.alertDestinations).values(row);
		return c.json(
			{
				alert_destination: toPublic(row),
				...(secret ? { secret } : {}),
			},
			201,
		);
	},
);

alertsRoutes.get('/', async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const rows = await db(c.env)
		.select()
		.from(schema.alertDestinations)
		.where(eq(schema.alertDestinations.site_id, siteId))
		.orderBy(desc(schema.alertDestinations.created_at));
	return c.json({ alert_destinations: rows.map(toPublic) });
});

alertsRoutes.post(
	'/rules',
	vValidator('json', MetricAlertRuleSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		const row = {
			id: crypto.randomUUID(),
			site_id: body.site_id,
			name: body.name,
			metric: body.metric,
			operator: body.operator,
			threshold: body.threshold,
			severity: body.severity ?? 'warning',
			enabled: body.enabled === false ? 0 : 1,
			created_at: Date.now(),
		};
		await db(c.env).insert(schema.metricAlertRules).values(row);
		return c.json({ metric_alert_rule: toPublicRule(row) }, 201);
	},
);

alertsRoutes.get('/rules', async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const rows = await db(c.env)
		.select()
		.from(schema.metricAlertRules)
		.where(eq(schema.metricAlertRules.site_id, siteId))
		.orderBy(desc(schema.metricAlertRules.created_at));
	return c.json({ metric_alert_rules: rows.map(toPublicRule) });
});

/** Read bounds for the delivery log: the recent tail is what diagnoses a broken endpoint, and an
 * unbounded read of an append-only audit table is not something a query string may ask for. */
const DELIVERIES_DEFAULT_LIMIT = 50 as const;
const DELIVERIES_MAX_LIMIT = 200 as const;

/** Public view of one delivery attempt. `last_error` is a fixed transport code (or a binding's own
 * message), never anything request-derived, so it is safe to surface on this admin-only route. */
function toPublicDelivery(row: typeof schema.alertDeliveries.$inferSelect) {
	return {
		id: row.id,
		destination_id: row.destination_id,
		site_id: row.site_id,
		dedupe_key: row.dedupe_key,
		severity: row.severity as AlertSeverity,
		status: row.status,
		attempts: row.attempts,
		last_error: row.last_error,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

// IMPORTANT: without this read the delivery outcome is written and never surfaced, so a destination
// that has been rejecting every POST for a week produces no operator-visible signal anywhere.
alertsRoutes.get('/deliveries', async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const limitRaw = c.req.query('limit');
	// KISS: an unusable limit falls back to the default instead of 400ing — the bound exists to cap
	// the read, and none of the sibling handlers carry a query-parameter error taxonomy to join.
	const parsed = limitRaw === undefined ? DELIVERIES_DEFAULT_LIMIT : Number(limitRaw);
	const limit =
		Number.isFinite(parsed) && parsed >= 1
			? Math.min(Math.trunc(parsed), DELIVERIES_MAX_LIMIT)
			: DELIVERIES_DEFAULT_LIMIT;
	const rows = await db(c.env)
		.select()
		.from(schema.alertDeliveries)
		.where(eq(schema.alertDeliveries.site_id, siteId))
		.orderBy(desc(schema.alertDeliveries.created_at))
		.limit(limit);
	return c.json({ alert_deliveries: rows.map(toPublicDelivery) });
});

alertsRoutes.delete('/rules/:id', async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const deleted = await db(c.env)
		.delete(schema.metricAlertRules)
		.where(
			and(
				eq(schema.metricAlertRules.id, c.req.param('id')),
				eq(schema.metricAlertRules.site_id, siteId),
			),
		)
		.returning({ id: schema.metricAlertRules.id });
	if (deleted.length === 0) {
		return c.json({ error: 'not_found' }, 404);
	}
	// Delivery rows are an audit trail and intentionally outlive the rule that caused them.
	return c.json({ deleted: true });
});

alertsRoutes.delete('/:id', async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const deleted = await db(c.env)
		.delete(schema.alertDestinations)
		.where(
			and(
				eq(schema.alertDestinations.id, c.req.param('id')),
				eq(schema.alertDestinations.site_id, siteId),
			),
		)
		.returning({ id: schema.alertDestinations.id });
	if (deleted.length === 0) {
		return c.json({ error: 'not_found' }, 404);
	}
	// Delivery history is left in place: it is the audit trail of what was sent, and the unique
	// (destination_id, dedupe_key) rows are harmless once the destination is gone.
	return c.json({ deleted: true });
});
