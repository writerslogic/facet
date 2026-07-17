// T059: funnel report. For each session in range, walk its time-ordered events and advance a step
// pointer only on an in-order match of the next step. steps[i].count is the number of sessions that
// reached step i; overall_rate = steps[last].count / steps[0].count (0 when step0 is 0).

import type { Funnel, FunnelReportResult, StatsFilter } from '@facet/shared';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { Env } from '../env.js';
import { DAY_MS } from '../lib/constants.js';
import { db } from './queries.js';
import * as schema from './schema.js';

interface SessionRow {
	visitorHash: string;
	startedAt: number;
	endedAt: number;
}

interface EventRow {
	visitorHash: string;
	path: string;
	name: string | null;
	createdAt: number;
}

/** Compute per-step reach counts and the overall completion rate for `funnel` over the range. */
export async function funnelReport(
	env: Env,
	funnel: Funnel,
	f: StatsFilter,
): Promise<FunnelReportResult> {
	const counts = funnel.steps.map(() => 0);

	const sessions = (await db(env)
		.select({
			visitorHash: schema.eventSessions.visitorHash,
			startedAt: schema.eventSessions.startedAt,
			endedAt: schema.eventSessions.endedAt,
		})
		.from(schema.eventSessions)
		.where(
			and(
				eq(schema.eventSessions.siteId, f.siteId),
				gte(schema.eventSessions.startedAt, f.start),
				lt(schema.eventSessions.startedAt, f.end),
			),
		)) as SessionRow[];

	const events = (await db(env)
		.select({
			visitorHash: schema.events.visitorHash,
			path: schema.events.path,
			name: schema.events.name,
			createdAt: schema.events.createdAt,
		})
		.from(schema.events)
		.where(
			and(
				eq(schema.events.siteId, f.siteId),
				gte(schema.events.createdAt, f.start),
				lt(schema.events.createdAt, f.end + DAY_MS),
			),
		)
		.orderBy(asc(schema.events.createdAt))) as EventRow[];

	const byVisitor = new Map<string, EventRow[]>();
	for (const e of events) {
		const list = byVisitor.get(e.visitorHash);
		if (list) {
			list.push(e);
		} else {
			byVisitor.set(e.visitorHash, [e]);
		}
	}

	for (const session of sessions) {
		const sessionEvents = (byVisitor.get(session.visitorHash) ?? []).filter(
			(e) => e.createdAt >= session.startedAt && e.createdAt <= session.endedAt,
		);
		let pointer = 0;
		for (const e of sessionEvents) {
			if (pointer >= funnel.steps.length) {
				break;
			}
			const step = funnel.steps[pointer];
			if (!step) {
				break;
			}
			const value = step.type === 'event' ? e.name : e.path;
			if (value === step.match_value) {
				pointer += 1;
			}
		}
		for (let i = 0; i < pointer; i += 1) {
			counts[i] = (counts[i] ?? 0) + 1;
		}
	}

	const steps = funnel.steps.map((step, index) => ({
		index,
		match_value: step.match_value,
		count: counts[index] ?? 0,
	}));
	const first = counts[0] ?? 0;
	const last = counts[counts.length - 1] ?? 0;
	const overallRate = first === 0 ? 0 : last / first;

	return { steps, overall_rate: overallRate };
}
