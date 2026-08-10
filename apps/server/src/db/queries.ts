// Typed D1 access via Drizzle. `db(env)` builds a schema-bound Drizzle client; all query helpers
// (insert event, upsert session, read aggregates) hang off it so table/column types stay inferred.
// Drizzle builds parameterized statements — no raw SQL strings here.

import type { EventProps } from '@facet/shared';
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
	browser?: string | null;
	os?: string | null;
	formFactor?: string | null;
	region?: string | null;
	city?: string | null;
	timezone?: string | null;
	network?: string | null;
	connection?: string | null;
	language?: string | null;
	screenTier?: string | null;
	orientation?: string | null;
	dprClass?: string | null;
	value?: number | null;
	currency?: string | null;
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
		})
		.onConflictDoNothing();
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

/** A visitor session to upsert alongside an event. */
export interface NewSession {
	siteId: string;
	visitorHash: string;
	dayKey: string;
	firstSeen: number;
}

/**
 * Persist a batch of already-derived events + their sessions in a SINGLE D1 round-trip. Used by the
 * queue consumer so the beacon hot path only enqueues (the writes move off it). Inserts carry the id
 * minted at derive time and `onConflictDoNothing`, so an at-least-once redelivery re-inserts the same
 * rows as no-ops (idempotent) — a retry can never duplicate an event.
 */
export async function persistEvents(
	env: Env,
	items: { id: string; row: NewEvent; session: NewSession }[],
): Promise<void> {
	if (items.length === 0) return;
	const client = db(env);
	const stmts = items.flatMap((it) => [
		client
			.insert(schema.events)
			.values({
				...it.row,
				id: it.id,
				props: it.row.props ? JSON.stringify(it.row.props) : null,
			})
			.onConflictDoNothing(),
		client.insert(schema.sessions).values(it.session).onConflictDoNothing(),
	]);
	await client.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
}
