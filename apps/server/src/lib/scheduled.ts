// Scheduled-job registry. The cron handler iterates `JOBS`, running each inside its own try/catch
// so one job's failure never skips another.

import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { HOUR_MS } from './constants.js';
import { createLogger } from './log.js';
import { enforceCrmAuditRetention, enforceRetention } from './retention.js';
import { runRollups } from './rollups.js';
import { dayKey } from './salt.js';
import { buildSessions } from './sessions.js';
import { runTransparency } from './transparency.js';

/** A unit of scheduled work: a stable name and an idempotent run function. */
export interface ScheduledJob {
	name: string;
	run(env: Env, now: number): Promise<void>;
}

/** The registered cron jobs, executed in order on every trigger. */
export const JOBS: ScheduledJob[] = [];

/** Append a job to the cron registry. */
export function registerJob(job: ScheduledJob): void {
	JOBS.push(job);
}

registerJob({ name: 'rollups', run: (env, now) => runRollups(env, now) });
registerJob({
	name: 'sessions',
	run: async (env, now) => {
		await buildSessions(env, dayKey(now - HOUR_MS));
	},
});
registerJob({
	name: 'retention',
	run: (env, now) => enforceRetention(env, now),
});
// Optional: age out the CRM audit log on its own, longer window. No-op unless CRM_DB is bound.
registerJob({
	name: 'crm-audit-retention',
	run: async (env, now) => {
		await enforceCrmAuditRetention(env, now);
	},
});
// Optional: maintain the MMR transparency log + signed checkpoint. No-op unless FACET_SIGNING_JWK is set.
registerJob({
	name: 'transparency-log',
	run: (env, now) => runTransparency(env, now),
});

/** Run every registered job, isolating failures so one bad job never blocks the rest. */
export async function runScheduled(
	event: ScheduledController,
	env: Env,
	jobs: ScheduledJob[] = JOBS,
): Promise<void> {
	const now = event.scheduledTime;
	const log = createLogger({ handler: 'scheduled' });
	for (const job of jobs) {
		let failure: unknown;
		try {
			await job.run(env, now);
		} catch (err) {
			failure = err;
			log.error(`job_failed:${job.name}`, err instanceof Error ? err : String(err));
		}
		try {
			if (failure !== undefined) {
				await db(env)
					.insert(schema.scheduledJobRuns)
					.values({
						name: job.name,
						lastSuccessAt: null,
						lastFailureAt: now,
						lastError: failure instanceof Error ? failure.name : 'UnknownError',
					})
					.onConflictDoUpdate({
						target: schema.scheduledJobRuns.name,
						set: {
							lastFailureAt: now,
							lastError: failure instanceof Error ? failure.name : 'UnknownError',
						},
					});
				continue;
			}
			await db(env)
				.insert(schema.scheduledJobRuns)
				.values({
					name: job.name,
					lastSuccessAt: now,
					lastFailureAt: null,
					lastError: null,
				})
				.onConflictDoUpdate({
					target: schema.scheduledJobRuns.name,
					set: { lastSuccessAt: now, lastError: null },
				});
		} catch (heartbeatError) {
			log.error('job_heartbeat_failed', heartbeatError, { job: job.name });
		}
	}
}
