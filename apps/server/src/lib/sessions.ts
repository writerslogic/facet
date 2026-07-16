// Sessionization: fold a day's raw `events` into `event_sessions`. Events are grouped per
// (site, visitor); a new session starts whenever the gap between adjacent events exceeds
// SESSION_TIMEOUT_MS. Session ids are deterministic (sha256 of site|visitor|startedAt) so a
// re-run upserts identical rows — idempotent (see the DRY/idempotency mandate).

import { and, asc, gte, lt } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { DAY_MS, SESSION_TIMEOUT_MS } from './constants.js';
import { sha256Hex } from './crypto.js';

interface EventRow {
	siteId: string;
	visitorHash: string;
	path: string;
	name: string | null;
	channel: string | null;
	createdAt: number;
}

/** Build (upsert) `event_sessions` for the UTC day identified by `dayKey`. Returns rows written. */
export async function buildSessions(env: Env, dayKey: string): Promise<number> {
	const dayStart = Date.parse(`${dayKey}T00:00:00.000Z`);
	const dayEnd = dayStart + DAY_MS;

	const rows = (await db(env)
		.select({
			siteId: schema.events.siteId,
			visitorHash: schema.events.visitorHash,
			path: schema.events.path,
			name: schema.events.name,
			channel: schema.events.channel,
			createdAt: schema.events.createdAt,
		})
		.from(schema.events)
		.where(and(gte(schema.events.createdAt, dayStart), lt(schema.events.createdAt, dayEnd)))
		.orderBy(
			asc(schema.events.siteId),
			asc(schema.events.visitorHash),
			asc(schema.events.createdAt),
		)) as EventRow[];

	let group: EventRow[] = [];
	let written = 0;

	const flush = async () => {
		if (group.length === 0) {
			return;
		}
		const first = group[0];
		const last = group[group.length - 1];
		if (!first || !last) {
			return;
		}
		let pageviews = 0;
		let events = 0;
		for (const e of group) {
			if (e.name === null) {
				pageviews += 1;
			} else {
				events += 1;
			}
		}
		const startedAt = first.createdAt;
		const endedAt = last.createdAt;
		const id = await sha256Hex(`${first.siteId}|${first.visitorHash}|${startedAt}`);
		const row = {
			id,
			siteId: first.siteId,
			visitorHash: first.visitorHash,
			dayKey,
			startedAt,
			endedAt,
			entryPath: first.path,
			exitPath: last.path,
			channel: first.channel,
			pageviews,
			events,
			durationMs: endedAt - startedAt,
			isBounce: pageviews <= 1 ? 1 : 0,
		};
		await db(env)
			.insert(schema.eventSessions)
			.values(row)
			.onConflictDoUpdate({ target: schema.eventSessions.id, set: row });
		written += 1;
		group = [];
	};

	let prev: EventRow | undefined;
	for (const e of rows) {
		if (prev) {
			const sameVisitor = prev.siteId === e.siteId && prev.visitorHash === e.visitorHash;
			const gapExceeded = e.createdAt - prev.createdAt > SESSION_TIMEOUT_MS;
			if (!sameVisitor || gapExceeded) {
				await flush();
			}
		}
		group.push(e);
		prev = e;
	}
	await flush();

	return written;
}
