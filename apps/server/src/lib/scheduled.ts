// Scheduled-job registry. The cron handler iterates `JOBS`, running each inside its own try/catch
// so one job's failure never skips another. Later cron work registers a job here instead of
// editing `runScheduled` (see the DRY mandate).

import type { Env } from '../env.js';
import { HOUR_MS } from './constants.js';
import { createLogger } from './log.js';
import { enforceRetention } from './retention.js';
import { runRollups } from './rollups.js';
import { dayKey } from './salt.js';
import { buildSessions } from './sessions.js';
import { notifyAnomalies } from './webhook.js';

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
// Optional: deliver anomaly-alert webhooks. No-op unless WEBHOOK_URL is configured.
registerJob({
	name: 'anomaly-alerts',
	run: (env, now) => notifyAnomalies(env, now),
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
		try {
			await job.run(env, now);
		} catch (err) {
			log.error(`job_failed:${job.name}`, err instanceof Error ? err : String(err));
		}
	}
}
