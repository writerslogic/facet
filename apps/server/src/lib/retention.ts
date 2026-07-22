// Retention cleanup: delete raw events, sessions, and salts older than the rolling window.
// `event_rollups` are durable history and are never deleted. Invoked from the cron handler.

import { lt } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { DAY_MS, DEFAULT_RAW_RETENTION_DAYS } from './constants.js';

/** Purge raw rows older than `RAW_RETENTION_DAYS` (falling back to the default when unset/NaN). */
export async function enforceRetention(env: Env, now: number): Promise<void> {
	// Require a positive integer: parseInt never yields Infinity, so `!Number.isFinite` would let "0",
	// a negative, or a partial parse ("30days"→30 is fine, but "0"/"-5") through — and days<=0 makes the
	// cutoff >= now, purging live/current events on every run. Fall back to the default instead.
	let days = Number.parseInt(env.RAW_RETENTION_DAYS, 10);
	if (!Number.isInteger(days) || days < 1) {
		days = DEFAULT_RAW_RETENTION_DAYS;
	}
	const cutoff = now - days * DAY_MS;
	await db(env).delete(schema.events).where(lt(schema.events.createdAt, cutoff));
	await db(env).delete(schema.sessions).where(lt(schema.sessions.firstSeen, cutoff));
	await db(env).delete(schema.salts).where(lt(schema.salts.createdAt, cutoff));
}
