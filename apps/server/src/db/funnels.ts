// Funnel report: per-session in-order step matching over materialized sessions.

import type { Funnel, FunnelReportResult, StatsFilter } from '@facet/shared';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Env } from '../env.js';
import { DAY_MS, chunked } from '../lib/constants.js';
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

	// Only visitors with a session in range can match a step (matching below is scoped to their
	// session window), so the events read is chunked over that visitor set instead of scanning
	// every event the site recorded across the whole range — the same IN-list chunking
	// contact-analytics.ts uses for D1's 100-bound-parameter cap.
	const visitorHashes = [...new Set(sessions.map((s) => s.visitorHash))];
	const byVisitor = new Map<string, EventRow[]>();
	const client = db(env);
	for (const batch of chunked(visitorHashes)) {
		const rows = (await client
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
					inArray(schema.events.visitorHash, batch),
					gte(schema.events.createdAt, f.start),
					lt(schema.events.createdAt, f.end + DAY_MS),
				),
			)
			.orderBy(asc(schema.events.createdAt))) as EventRow[];
		for (const e of rows) {
			const list = byVisitor.get(e.visitorHash);
			if (list) {
				list.push(e);
			} else {
				byVisitor.set(e.visitorHash, [e]);
			}
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
