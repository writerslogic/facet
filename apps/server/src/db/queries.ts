// Typed D1 access via Drizzle. `db(env)` builds a schema-bound Drizzle client; all query helpers
// (insert event, upsert session, read aggregates) hang off it so table/column types stay inferred.
// Drizzle builds parameterized statements — no raw SQL strings here.

import type { EventProps } from '@countless/shared';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../env.js';
import * as schema from './schema.js';

/** Build a schema-bound Drizzle client over the D1 binding. */
export function db(env: Env) {
	return drizzle(env.DB, { schema });
}

/** A raw event to persist. `props` is serialized to JSON on write. */
export interface NewEvent {
	siteId: string;
	hostname: string;
	path: string;
	referrer: string;
	name: string | null;
	props: EventProps | null;
	visitorHash: string;
	country: string | null;
	device: string | null;
	createdAt: number;
	utmSource?: string | null;
	utmMedium?: string | null;
	utmCampaign?: string | null;
	channel?: string | null;
}

/** Insert a raw event row. Returns the generated event id. */
export async function insertEvent(env: Env, row: NewEvent): Promise<string> {
	const id = crypto.randomUUID();
	await db(env)
		.insert(schema.events)
		.values({
			...row,
			id,
			props: row.props ? JSON.stringify(row.props) : null,
		});
	return id;
}

/** Record a visitor session for a UTC day, idempotently (one row per site/visitor/day). */
export async function upsertSession(
	env: Env,
	siteId: string,
	visitorHash: string,
	dayKey: string,
	firstSeen: number,
): Promise<void> {
	await db(env)
		.insert(schema.sessions)
		.values({ siteId, visitorHash, dayKey, firstSeen })
		.onConflictDoNothing();
}
