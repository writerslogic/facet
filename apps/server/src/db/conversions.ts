// Goal conversions over materialized sessions.

import type { Goal, StatsFilter } from '@facet/shared';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { db } from './queries.js';
import * as schema from './schema.js';

/** Count converting sessions for `goal` over the range, and the total sessions in range. */
export async function goalConversions(
	env: Env,
	siteId: string,
	goal: Goal,
	f: StatsFilter,
): Promise<{ conversions: number; sessions: number; rate: number }> {
	const matchColumn = goal.type === 'event' ? schema.events.name : schema.events.path;

	const sessionsRow = await db(env)
		.select({ count: sql<number>`COUNT(*)` })
		.from(schema.eventSessions)
		.where(
			and(
				eq(schema.eventSessions.siteId, siteId),
				gte(schema.eventSessions.startedAt, f.start),
				lt(schema.eventSessions.startedAt, f.end),
			),
		)
		.get();
	const sessions = Number(sessionsRow?.count ?? 0);
	if (sessions === 0) {
		return { conversions: 0, sessions: 0, rate: 0 };
	}

	const converted = sql<number>`EXISTS (
		SELECT 1 FROM ${schema.events}
		WHERE ${schema.events.siteId} = ${schema.eventSessions.siteId}
			AND ${schema.events.visitorHash} = ${schema.eventSessions.visitorHash}
			AND ${schema.events.createdAt} >= ${schema.eventSessions.startedAt}
			AND ${schema.events.createdAt} <= ${schema.eventSessions.endedAt}
			AND ${matchColumn} = ${goal.match_value}
	)`;
	const conversionsRow = await db(env)
		.select({
			count: sql<number>`SUM(CASE WHEN ${converted} THEN 1 ELSE 0 END)`,
		})
		.from(schema.eventSessions)
		.where(
			and(
				eq(schema.eventSessions.siteId, siteId),
				gte(schema.eventSessions.startedAt, f.start),
				lt(schema.eventSessions.startedAt, f.end),
			),
		)
		.get();
	const conversions = Number(conversionsRow?.count ?? 0);

	return { conversions, sessions, rate: conversions / sessions };
}
