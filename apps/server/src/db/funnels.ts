// Funnel report: per-session in-order step matching over materialized sessions.

import type { Funnel, FunnelReportResult, StatsFilter } from '@facet/shared';
import { and, asc, eq, gte, inArray, lt, or } from 'drizzle-orm';
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

	const pathValues = [
		...new Set(funnel.steps.filter((s) => s.type === 'path').map((s) => s.match_value)),
	];
	const eventValues = [
		...new Set(funnel.steps.filter((s) => s.type === 'event').map((s) => s.match_value)),
	];
	// PERF: matching only ever compares an event against a step's own match_value, so a row matching
	// none of them can never advance the pointer. Pushing that into SQL keeps the read proportional to
	// funnel-relevant traffic instead of to every pageview in the range, and a funnel is capped at 10
	// steps, so the IN-lists stay far inside D1's 100-bound-parameter limit.
	const stepMatch = or(
		pathValues.length > 0 ? inArray(schema.events.path, pathValues) : undefined,
		eventValues.length > 0 ? inArray(schema.events.name, eventValues) : undefined,
	);
	if (!stepMatch) {
		return { steps: [], overall_rate: 0 };
	}

	const client = db(env);
	const sessions = (await client
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
		)
		.orderBy(asc(schema.eventSessions.startedAt))) as SessionRow[];

	// One statement, not one per chunk of visitors: a per-visitor `IN (...)` read costs a D1 round
	// trip per 90 visitors, and a busy site's 90-day range crosses the Worker's subrequest ceiling
	// long before the query itself is the problem.
	const rows =
		sessions.length === 0
			? []
			: ((await client
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
							stepMatch,
						),
					)
					.orderBy(asc(schema.events.createdAt))) as EventRow[]);

	const byVisitor = new Map<string, EventRow[]>();
	for (const e of rows) {
		const list = byVisitor.get(e.visitorHash);
		if (list) {
			list.push(e);
		} else {
			byVisitor.set(e.visitorHash, [e]);
		}
	}

	const sessionsByVisitor = new Map<string, SessionRow[]>();
	for (const s of sessions) {
		const list = sessionsByVisitor.get(s.visitorHash);
		if (list) {
			list.push(s);
		} else {
			sessionsByVisitor.set(s.visitorHash, [s]);
		}
	}

	for (const [visitorHash, visitorSessions] of sessionsByVisitor) {
		const visitorEvents = byVisitor.get(visitorHash);
		if (!visitorEvents) {
			continue;
		}
		// PERF: one visitor's sessions are disjoint and both lists are time-ordered, so the cursor only
		// moves forward. Re-filtering the whole event list per session was quadratic in the activity of
		// the visitors who see the funnel most.
		let cursor = 0;
		for (const session of visitorSessions) {
			while (cursor < visitorEvents.length) {
				const e = visitorEvents[cursor];
				if (!e || e.createdAt >= session.startedAt) {
					break;
				}
				cursor += 1;
			}
			let pointer = 0;
			for (let i = cursor; i < visitorEvents.length; i += 1) {
				const e = visitorEvents[i];
				if (!e || e.createdAt > session.endedAt) {
					break;
				}
				const step = funnel.steps[pointer];
				if (!step) {
					break;
				}
				const value = step.type === 'event' ? e.name : e.path;
				if (value === step.match_value) {
					pointer += 1;
					if (pointer >= funnel.steps.length) {
						break;
					}
				}
			}
			for (let i = 0; i < pointer; i += 1) {
				counts[i] = (counts[i] ?? 0) + 1;
			}
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
