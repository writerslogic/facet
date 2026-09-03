// Alert configuration reads and the delivery-claim protocol that makes alerting exactly-once-ish.
//
// The dedupe contract lives here, in SQL, not in application logic: a delivery is CLAIMED before it
// is attempted, and the claim is a single atomic statement. That is what survives the three ways
// this can go wrong — the cron running twice, the isolate dying mid-POST, and the same anomalous
// alert fact being re-detected on the next run (anomaly and threshold evaluation both deliberately
// revisit the same completed hour when a cron trigger is delayed or duplicated).

import { and, asc, eq, isNotNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { db } from './queries.js';
import * as schema from './schema.js';

/** Attempts after which a destination stops being retried for one anomaly. Bounded so a permanently
 * broken endpoint cannot make the cron do unbounded work every hour, forever. */
export const ALERT_MAX_ATTEMPTS = 3 as const;

/** A 'pending' claim younger than this must not be re-claimed; older, the isolate holding it is
 * presumed dead. `now` is always `event.scheduledTime` (one fixed value per cron invocation, never
 * wall-clock), so a same-tick duplicate always compares exactly equal and is blocked regardless of
 * this constant — it is not measuring real elapsed delivery time. If `now` is ever switched to real
 * wall-clock time, this becomes load-bearing against actual latency and must be reassessed. */
const PENDING_CLAIM_STALE_MS = 30_000 as const;

/** The cron is hourly, but the timestamped backoff also behaves correctly for manually retried or
 * more frequent schedules. Attempts wait 5 then 10 minutes; the third failure is terminal. */
const ALERT_RETRY_BASE_MS = 5 * 60_000;
const ALERT_RETRY_LIMIT = 100;

/** A destination row as stored (secret included — only the delivery path may read it). */
export interface StoredDestination {
	id: string;
	site_id: string;
	name: string;
	type: string;
	target: string;
	min_severity: string;
	secret: string | null;
	enabled: number;
	created_at: number;
}

/** A metric rule as stored. Only enabled rules enter the cron evaluation path. */
export interface StoredMetricAlertRule {
	id: string;
	site_id: string;
	name: string;
	metric: string;
	operator: string;
	threshold: number;
	severity: string;
	enabled: number;
	created_at: number;
}

/** Every enabled destination across all sites, in one query — the cron's entry point. */
export async function enabledDestinations(env: Env): Promise<StoredDestination[]> {
	return db(env)
		.select()
		.from(schema.alertDestinations)
		.where(eq(schema.alertDestinations.enabled, 1))
		.all();
}

/** Every enabled threshold rule across all sites, in one query.
 * OPTIMIZE: idx_metric_alert_rules_site leads with site_id, so a rule scan is the plan here;
 * config-sized table, once an hour. An index leading with `enabled` would seek. */
export async function enabledMetricAlertRules(env: Env): Promise<StoredMetricAlertRule[]> {
	return db(env)
		.select()
		.from(schema.metricAlertRules)
		.where(eq(schema.metricAlertRules.enabled, 1))
		.all();
}

/** A claimed delivery: the row to record the outcome against, and which attempt this is. */
export interface DeliveryClaim {
	id: string;
	attempt: number;
}

/**
 * Claim the right to deliver `dedupeKey` to `destinationId`, or return null if there is nothing to
 * do (already delivered, or out of attempts).
 *
 * Two atomic statements, never a read-then-write: the INSERT ... ON CONFLICT DO NOTHING wins the
 * first-ever claim, and the conditional UPDATE wins a retry. Both use RETURNING, so a concurrent
 * caller that loses the race gets an empty result and skips — the anomaly is delivered once, not
 * once per overlapping cron.
 */
export async function claimDelivery(
	env: Env,
	input: {
		destinationId: string;
		siteId: string;
		dedupeKey: string;
		severity: string;
		now: number;
	},
): Promise<DeliveryClaim | null> {
	const { destinationId, siteId, dedupeKey, severity, now } = input;
	const inserted = await db(env)
		.insert(schema.alertDeliveries)
		.values({
			id: crypto.randomUUID(),
			destination_id: destinationId,
			site_id: siteId,
			dedupe_key: dedupeKey,
			severity,
			status: 'pending',
			// Counted at claim time, not at outcome time: an isolate that dies mid-POST must still
			// burn an attempt, else a hanging endpoint retries forever.
			attempts: 1,
			created_at: now,
			updated_at: now,
		})
		.onConflictDoNothing()
		.returning({ id: schema.alertDeliveries.id });
	const first = inserted[0];
	if (first) {
		return { id: first.id, attempt: 1 };
	}

	const retried = await db(env)
		.update(schema.alertDeliveries)
		.set({
			attempts: sql`${schema.alertDeliveries.attempts} + 1`,
			status: 'pending',
			next_attempt_at: null,
			updated_at: now,
		})
		.where(
			and(
				eq(schema.alertDeliveries.destination_id, destinationId),
				eq(schema.alertDeliveries.dedupe_key, dedupeKey),
				// A delivered alert is never re-sent — this is the "never spam" guarantee.
				ne(schema.alertDeliveries.status, 'delivered'),
				lt(schema.alertDeliveries.attempts, ALERT_MAX_ATTEMPTS),
				// A fresh 'pending' row may be another caller's in-flight delivery (duplicate Cron Trigger
				// fire) — only re-claim it once stale enough that the holder is presumed dead.
				or(
					and(
						eq(schema.alertDeliveries.status, 'failed'),
						lte(schema.alertDeliveries.next_attempt_at, now),
					),
					and(
						eq(schema.alertDeliveries.status, 'pending'),
						lt(schema.alertDeliveries.updated_at, now - PENDING_CLAIM_STALE_MS),
					),
				),
			),
		)
		.returning({
			id: schema.alertDeliveries.id,
			attempts: schema.alertDeliveries.attempts,
		});
	const row = retried[0];
	return row ? { id: row.id, attempt: row.attempts } : null;
}

/** Record a successful delivery. Terminal: this alert will never be sent again. */
export async function markDelivered(env: Env, deliveryId: string, now: number): Promise<void> {
	await db(env)
		.update(schema.alertDeliveries)
		.set({ status: 'delivered', last_error: null, next_attempt_at: null, updated_at: now })
		.where(eq(schema.alertDeliveries.id, deliveryId));
}

/** Retain the exact alert fact before transport so a later invocation can replay it. */
export async function storeDeliveryPayload(
	env: Env,
	deliveryId: string,
	payload: string,
	now: number,
): Promise<void> {
	await db(env)
		.update(schema.alertDeliveries)
		.set({ payload, updated_at: now })
		.where(eq(schema.alertDeliveries.id, deliveryId));
}

/** Record a failed delivery and schedule its next bounded attempt. */
export async function markFailed(
	env: Env,
	deliveryId: string,
	now: number,
	error: string,
	attempt: number,
): Promise<void> {
	const nextAttemptAt =
		attempt < ALERT_MAX_ATTEMPTS ? now + ALERT_RETRY_BASE_MS * 2 ** (attempt - 1) : null;
	await db(env)
		.update(schema.alertDeliveries)
		.set({
			status: 'failed',
			last_error: error.slice(0, 200),
			next_attempt_at: nextAttemptAt,
			updated_at: now,
		})
		.where(eq(schema.alertDeliveries.id, deliveryId));
}

/** A failed delivery joined to its currently enabled destination. */
export interface StoredAlertRetry {
	deliveryId: string;
	dedupeKey: string;
	severity: string;
	payload: string;
	destination: StoredDestination;
}

/** Bounded, oldest-first retry candidates. Disabled/deleted destinations are deliberately omitted. */
export async function dueAlertRetries(env: Env, now: number): Promise<StoredAlertRetry[]> {
	const rows = await db(env)
		.select({
			deliveryId: schema.alertDeliveries.id,
			dedupeKey: schema.alertDeliveries.dedupe_key,
			severity: schema.alertDeliveries.severity,
			payload: schema.alertDeliveries.payload,
			id: schema.alertDestinations.id,
			site_id: schema.alertDestinations.site_id,
			name: schema.alertDestinations.name,
			type: schema.alertDestinations.type,
			target: schema.alertDestinations.target,
			min_severity: schema.alertDestinations.min_severity,
			secret: schema.alertDestinations.secret,
			enabled: schema.alertDestinations.enabled,
			created_at: schema.alertDestinations.created_at,
		})
		.from(schema.alertDeliveries)
		.innerJoin(
			schema.alertDestinations,
			and(
				eq(schema.alertDestinations.id, schema.alertDeliveries.destination_id),
				eq(schema.alertDestinations.enabled, 1),
			),
		)
		.where(
			and(
				eq(schema.alertDeliveries.status, 'failed'),
				lt(schema.alertDeliveries.attempts, ALERT_MAX_ATTEMPTS),
				isNotNull(schema.alertDeliveries.payload),
				lte(schema.alertDeliveries.next_attempt_at, now),
			),
		)
		.orderBy(asc(schema.alertDeliveries.next_attempt_at))
		.limit(ALERT_RETRY_LIMIT);
	return rows.flatMap((row) =>
		row.payload === null
			? []
			: [
					{
						deliveryId: row.deliveryId,
						dedupeKey: row.dedupeKey,
						severity: row.severity,
						payload: row.payload,
						destination: {
							id: row.id,
							site_id: row.site_id,
							name: row.name,
							type: row.type,
							target: row.target,
							min_severity: row.min_severity,
							secret: row.secret,
							enabled: row.enabled,
							created_at: row.created_at,
						},
					},
				],
	);
}
