// Sessionization: fold a day's raw `events` into `event_sessions`. Events are grouped per
// (site, visitor); a new session starts whenever the gap between adjacent events exceeds
// SESSION_TIMEOUT_MS. Session ids are deterministic (sha256 of site|visitor|startedAt) so a
// re-run upserts identical rows — idempotent.

import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { DAY_MS, SESSION_TIMEOUT_MS } from './constants.js';
import { sha256Hex } from './crypto.js';
import { dayKey as calendarDayKey } from './salt.js';

interface EventRow {
	siteId: string;
	visitorHash: string;
	path: string;
	name: string | null;
	channel: string | null;
	createdAt: number;
}

const EVENT_COLUMNS = {
	siteId: schema.events.siteId,
	visitorHash: schema.events.visitorHash,
	path: schema.events.path,
	name: schema.events.name,
	channel: schema.events.channel,
	createdAt: schema.events.createdAt,
};

// Caps the backward walk below against a pathological chain of sub-timeout gaps (e.g. a bot pinging
// every 29 minutes for days); a real session never needs this much.
const BACKWARD_RESOLVE_FLOOR_MS = 3 * DAY_MS;

/** A day-window query truncates a spanning session at whichever event happens to fall inside the
 * window — not necessarily its true start, since a chain of sub-timeout gaps can push the real start
 * arbitrarily further back (grouping is transitive). Walk backward one hop at a time — each hop only
 * looks inside the timeout danger zone, so a genuine >timeout gap terminates it — until the true
 * start is found or the safety floor is hit. Returns the earlier rows to prepend, oldest first. */
async function resolveSpanningStart(
	env: Env,
	siteId: string,
	visitorHash: string,
	truncatedFirst: EventRow,
): Promise<EventRow[]> {
	const prefix: EventRow[] = [];
	let boundary = truncatedFirst.createdAt;
	const floor = boundary - BACKWARD_RESOLVE_FLOOR_MS;
	for (;;) {
		const [prev] = (await db(env)
			.select(EVENT_COLUMNS)
			.from(schema.events)
			.where(
				and(
					eq(schema.events.siteId, siteId),
					eq(schema.events.visitorHash, visitorHash),
					gte(schema.events.createdAt, Math.max(floor, boundary - SESSION_TIMEOUT_MS)),
					lt(schema.events.createdAt, boundary),
				),
			)
			.orderBy(desc(schema.events.createdAt))
			.limit(1)) as EventRow[];
		if (!prev) return prefix;
		prefix.unshift(prev);
		boundary = prev.createdAt;
		if (boundary <= floor) return prefix;
	}
}

/** Build (upsert) `event_sessions` for the UTC day identified by `dayKey`. Returns rows written.
 *
 * Queries a SESSION_TIMEOUT_MS lookback before `dayStart` so a visit spanning midnight groups with
 * its pre-midnight events instead of splitting into two sessions. A group that never reaches this day
 * (`last.createdAt < dayStart`) is skipped — the previous day's own run already wrote it. A group
 * whose start lands inside the lookback is truncation-prone, so `resolveSpanningStart` finds its true
 * start first; that resolved `startedAt` also decides the row's `dayKey`, so a spanning session is
 * attributed to the day it began, not the day it happens to end. */
export async function buildSessions(env: Env, dayKey: string): Promise<number> {
	const dayStart = Date.parse(`${dayKey}T00:00:00.000Z`);
	const dayEnd = dayStart + DAY_MS;
	const queryStart = dayStart - SESSION_TIMEOUT_MS;

	const rows = (await db(env)
		.select(EVENT_COLUMNS)
		.from(schema.events)
		.where(and(gte(schema.events.createdAt, queryStart), lt(schema.events.createdAt, dayEnd)))
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
		const last = group[group.length - 1];
		let first = group[0];
		if (!first || !last) {
			return;
		}
		if (last.createdAt < dayStart) {
			// Entirely inside the lookback window: this session belongs wholly to the previous day,
			// whose own run already wrote it.
			group = [];
			return;
		}
		if (first.createdAt < dayStart) {
			const prefix = await resolveSpanningStart(env, first.siteId, first.visitorHash, first);
			if (prefix.length > 0) {
				group = [...prefix, ...group];
				first = group[0];
			}
		}
		if (!first) {
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
			dayKey: calendarDayKey(startedAt),
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
