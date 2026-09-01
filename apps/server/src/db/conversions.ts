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

	const converted = sql<number>`EXISTS (
		SELECT 1 FROM ${schema.events}
		WHERE ${schema.events.siteId} = ${schema.eventSessions.siteId}
			AND ${schema.events.visitorHash} = ${schema.eventSessions.visitorHash}
			AND ${schema.events.createdAt} >= ${schema.eventSessions.startedAt}
			AND ${schema.events.createdAt} <= ${schema.eventSessions.endedAt}
			AND ${matchColumn} = ${goal.match_value}
	)`;
	// PERF: one D1 round-trip for both aggregates instead of two identical-WHERE queries, which
	// also stops a concurrent session insert landing between them and reporting rate > 1.
	const row = await db(env)
		.select({
			sessions: sql<number>`COUNT(*)`,
			conversions: sql<number>`SUM(CASE WHEN ${converted} THEN 1 ELSE 0 END)`,
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
	const sessions = Number(row?.sessions ?? 0);
	const conversions = Number(row?.conversions ?? 0);

	return { conversions, sessions, rate: sessions === 0 ? 0 : conversions / sessions };
}
