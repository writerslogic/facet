// Scheduled-job registry. The cron handler iterates `JOBS`, running each inside its own try/catch
// so one job's failure never skips another.

import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { refreshBotRulesets } from './bots-refresh.js';
import { occurrenceOf, parseCadence } from './cadence.js';
import { coarsenRollups } from './coarsen.js';
import { HOUR_MS } from './constants.js';
import { createLogger } from './log.js';
import { enforceCrmAuditRetention, enforceRetention } from './retention.js';
import { runRollups } from './rollups.js';
import { dayKey } from './salt.js';
import { buildSessions } from './sessions.js';
import { runTransparency } from './transparency.js';

/** A unit of scheduled work: a stable name, a `<hours>h` cadence, and an idempotent run function. */
export interface ScheduledJob {
	name: string;
	cadence: string;
	run(env: Env, now: number): Promise<void>;
}

/** The registered cron jobs, executed in order on every trigger. */
export const JOBS: ScheduledJob[] = [];

/** Append a job to the cron registry. */
export function registerJob(job: ScheduledJob): void {
	JOBS.push(job);
}

registerJob({ name: 'rollups', cadence: '1h', run: (env, now) => runRollups(env, now) });
registerJob({
	name: 'sessions',
	cadence: '1h',
	run: async (env, now) => {
		await buildSessions(env, dayKey(now - HOUR_MS));
	},
});
// IMPORTANT: hourly, not daily, and not for cost reasons. `enforceRetention` purges on a rolling
// `now - RAW_RETENTION_DAYS` cutoff, so its cadence IS the worst-case overshoot of the window the
// deployment advertises — and the salt/identity-salt deletes it ends with are what irreversibly
// sever the hash-to-input mapping that window promises. A daily cadence would hold raw visitor data
// up to 24h past the advertised window instead of up to 1h. `idx_events_created` (migration 0021)
// is what makes the hourly no-op delete cheap; spend that rather than the guarantee.
registerJob({
	name: 'retention',
	cadence: '1h',
	run: (env, now) => enforceRetention(env, now),
});
// Optional: age out the CRM audit log on its own, longer window. No-op unless CRM_DB is bound.
registerJob({
	name: 'crm-audit-retention',
	cadence: '24h',
	run: async (env, now) => {
		await enforceCrmAuditRetention(env, now);
	},
});
// Optional: maintain the MMR transparency log + signed checkpoint. No-op unless FACET_SIGNING_JWK is set.
registerJob({
	name: 'transparency-log',
	cadence: '1h',
	run: (env, now) => runTransparency(env, now),
});
registerJob({
	name: 'rollup-coarsening',
	cadence: '24h',
	run: (env, now) => coarsenRollups(env, now),
});
registerJob({
	name: 'bot-ruleset-refresh',
	cadence: '24h',
	run: (env, now) => refreshBotRulesets(env, now),
});

interface LedgerRow {
	lastOccurrence: number | null;
	cadenceError: string | null;
}

type Log = ReturnType<typeof createLogger>;

async function readLedger(env: Env, log: Log): Promise<Map<string, LedgerRow>> {
	try {
		const rows = await db(env)
			.select({
				name: schema.scheduledJobRuns.name,
				lastOccurrence: schema.scheduledJobRuns.lastOccurrence,
				cadenceError: schema.scheduledJobRuns.cadenceError,
			})
			.from(schema.scheduledJobRuns);
		return new Map(
			rows.map((r) => [
				r.name,
				{ lastOccurrence: r.lastOccurrence, cadenceError: r.cadenceError },
			]),
		);
	} catch (err) {
		// IMPORTANT: an unreadable ledger must not skip every job — degrade to the pre-ledger
		// behaviour and run them, which is safe because every job is idempotent.
		log.error('job_ledger_read_failed', err instanceof Error ? err : String(err));
		return new Map();
	}
}

async function writeCadenceError(
	env: Env,
	name: string,
	error: string | null,
	log: Log,
): Promise<void> {
	try {
		await db(env)
			.insert(schema.scheduledJobRuns)
			.values({ name, cadenceError: error })
			.onConflictDoUpdate({
				target: schema.scheduledJobRuns.name,
				set: { cadenceError: error },
			});
	} catch (err) {
		log.error('job_cadence_write_failed', err, { job: name });
	}
}

/** Run every registered job that is due, isolating failures so one bad job never blocks the rest. */
export async function runScheduled(
	event: ScheduledController,
	env: Env,
	jobs: ScheduledJob[] = JOBS,
): Promise<void> {
	const now = event.scheduledTime;
	const log = createLogger({ handler: 'scheduled' });
	const ledger = await readLedger(env, log);
	for (const job of jobs) {
		const row = ledger.get(job.name);
		const cadence = parseCadence(job.cadence);
		if (!cadence.ok) {
			// IMPORTANT: never fall back to a default cadence — running work on a schedule nobody
			// chose is worse than not running it. Disable this job alone.
			log.error(`job_cadence_invalid:${job.name}`, cadence.error);
			if (row?.cadenceError !== cadence.error) {
				await writeCadenceError(env, job.name, cadence.error, log);
			}
			continue;
		}
		if (row?.cadenceError != null) {
			await writeCadenceError(env, job.name, null, log);
		}
		const occurrence = occurrenceOf(now, cadence.ms);
		if (row?.lastOccurrence != null && row.lastOccurrence >= occurrence) continue;

		let failure: unknown;
		try {
			await job.run(env, now);
		} catch (err) {
			failure = err;
			log.error(`job_failed:${job.name}`, err instanceof Error ? err : String(err));
		}
		try {
			if (failure !== undefined) {
				// IMPORTANT: a failed run leaves `last_occurrence` untouched so the next trigger retries it.
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
					lastOccurrence: occurrence,
					cadenceError: null,
				})
				.onConflictDoUpdate({
					target: schema.scheduledJobRuns.name,
					set: {
						lastSuccessAt: now,
						lastError: null,
						lastOccurrence: occurrence,
						cadenceError: null,
					},
				});
		} catch (heartbeatError) {
			log.error('job_heartbeat_failed', heartbeatError, { job: job.name });
		}
	}
}
