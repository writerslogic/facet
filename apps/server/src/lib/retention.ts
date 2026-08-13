// Retention cleanup: delete raw events, BOTH session tables, salts, and identity mappings older than
// the rolling window. `event_rollups` are durable history and are never deleted. Invoked from the
// cron handler.
//
// "Sessions" is two tables, and saying it in the singular is what hid `event_sessions` here for as
// long as it did — see its delete for what the difference costs.
//
// Spent magic-link tokens are swept here too, on their own much shorter window — see the delete for
// why it is `now` and not the raw cutoff.
//
// The optional CRM has its own window and its own function. Contacts are NOT on any schedule — a
// contact is a business record that is deleted by an explicit act, never by a cron — but the audit
// log recording who read them is, because it is the one CRM table that grows on its own.

import { lt } from 'drizzle-orm';
import { purgeCrmAudit } from '../db/crm.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import {
	DAY_MS,
	DEFAULT_CRM_AUDIT_RETENTION_DAYS,
	DEFAULT_RAW_RETENTION_DAYS,
} from './constants.js';

/**
 * The deployment's raw-data window in days — the ONE reading of `RAW_RETENTION_DAYS`. Every caller
 * goes through this so the window that is enforced, the window that is attested, and the window any
 * other feature gates on can never disagree.
 *
 * Require a positive integer: parseInt never yields Infinity, so `!Number.isFinite` would let "0", a
 * negative, or a partial parse ("30days"→30 is fine, but "0"/"-5") through — and days<=0 makes the
 * cutoff >= now, purging live/current events on every run. Fall back to the default instead.
 */
export function retentionDays(env: Env): number {
	const days = Number.parseInt(env.RAW_RETENTION_DAYS, 10);
	return Number.isInteger(days) && days >= 1 ? days : DEFAULT_RAW_RETENTION_DAYS;
}

/**
 * Purge raw rows older than `RAW_RETENTION_DAYS` (falling back to the default when unset/NaN).
 *
 * Each delete is isolated in its own try/catch: `events` is the largest table and the most likely to
 * hit a transient D1 error, and it must never be able to block the salt/identity-salt deletes below it
 * — those are what irreversibly sever the hash→input mapping the retention window promises, and a
 * privacy-critical purge silently skipping every run because an unrelated table's delete threw would
 * defeat that promise. Every statement always runs; failures are collected and re-thrown together at
 * the end so the caller (`runScheduled`) still sees and logs the job as failed.
 */
export async function enforceRetention(env: Env, now: number): Promise<void> {
	const cutoff = now - retentionDays(env) * DAY_MS;
	const errors: unknown[] = [];
	const purge = async (fn: () => Promise<unknown>): Promise<void> => {
		try {
			await fn();
		} catch (err) {
			errors.push(err);
		}
	};

	await purge(() => db(env).delete(schema.events).where(lt(schema.events.createdAt, cutoff)));
	await purge(() => db(env).delete(schema.sessions).where(lt(schema.sessions.firstSeen, cutoff)));
	// The OTHER session table. `sessions` is the per-day dedupe key behind the visitor count;
	// `event_sessions` is the materialized visit the cron folds out of raw events, and it carries the
	// visitor hash alongside entry path, exit path, duration and bounce. Purging the first and not the
	// second left the richer of the two — a per-visitor behavioural record — retained forever, outliving
	// by any margin the events it was derived from and the salt that could explain its hash.
	//
	// Keyed on `started_at`, the timestamp of the row's FIRST event, so the summary can never outlive
	// what it summarises: present exactly while the events it was folded from are. `ended_at` would
	// invert that — a visit straddling the cutoff would keep an aggregate counting rows that are gone.
	// It is also the same key by the same reasoning as `sessions.first_seen` directly above.
	await purge(() =>
		db(env).delete(schema.eventSessions).where(lt(schema.eventSessions.startedAt, cutoff)),
	);
	await purge(() => db(env).delete(schema.salts).where(lt(schema.salts.createdAt, cutoff)));
	// Windowed identity salts purge on window END, not creation: the salt outlives every event whose
	// timestamp could fall in its window, then is destroyed — irreversibly severing the hash→input
	// mapping exactly like the daily salt, at the chosen granularity. Linkage is bounded by retention.
	await purge(() =>
		db(env).delete(schema.identitySalts).where(lt(schema.identitySalts.window_end, cutoff)),
	);
	// Consent records aged past the window: the events they governed are gone, so drop the mapping and
	// the at-rest raw uid. (Elevation already stops the instant a record expires or is revoked.)
	await purge(() =>
		db(env).delete(schema.consentRecords).where(lt(schema.consentRecords.granted_at, cutoff)),
	);
	// Magic-link tokens, keyed on their OWN expiry rather than the raw window — a token's life is
	// fifteen minutes, so ageing it out over ninety days would keep it for the other eighty-nine and a
	// half for no reason. `consumeMagicToken` already refuses any row whose `expires_at` has passed, so
	// nothing redeemable is removed here and a replay hits the same 401 either way.
	//
	// It is a retention concern rather than a housekeeping one: `auth_tokens` was written by two paths
	// and read by one, and deleted by NOTHING, so every login attempt a deployment ever served left a
	// permanent row holding the operator's email address long after the link it authorised went dead.
	// That is exactly the accumulation this job exists to stop, on the one table that was missed.
	await purge(() =>
		db(env).delete(schema.authTokens).where(lt(schema.authTokens.expiresAt, now)),
	);

	if (errors.length > 0) {
		// log.error only reads `.message`/`.name` off the thrown error — AggregateError.errors is
		// non-enumerable and would otherwise vanish from the log entirely, leaving only this synthetic
		// wrapper text and none of the actual per-table failure reasons.
		const detail = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
		throw new AggregateError(
			errors,
			`enforceRetention: ${errors.length} purge statement(s) failed: ${detail}`,
		);
	}
}

/**
 * The audit log's window in days — the ONE reading of `CRM_AUDIT_RETENTION_DAYS`, validated exactly
 * as `retentionDays` validates its own var and for the same reason: a zero or negative value puts the
 * cutoff at or after `now` and every run would erase the log it was meant to age.
 */
export function crmAuditRetentionDays(env: Env): number {
	const days = Number.parseInt(env.CRM_AUDIT_RETENTION_DAYS ?? '', 10);
	return Number.isInteger(days) && days >= 1 ? days : DEFAULT_CRM_AUDIT_RETENTION_DAYS;
}

/**
 * Purge audit entries older than `CRM_AUDIT_RETENTION_DAYS`. A no-op on a deployment with no CRM
 * binding, which has no such table — the extension being off means it does not exist, not that it is
 * empty.
 *
 * Separate from `enforceRetention` rather than folded into it because they are different windows over
 * different databases, and because the cron isolates failures per job: an unreachable `CRM_DB` must
 * not be able to stop raw events being purged from the analytics one.
 *
 * Returns entries purged, which is zero on an unbound deployment for the same reason it is zero on a
 * quiet one.
 */
export async function enforceCrmAuditRetention(env: Env, now: number): Promise<number> {
	if (!env.CRM_DB) return 0;
	return purgeCrmAudit(env.CRM_DB, now - crmAuditRetentionDays(env) * DAY_MS);
}
