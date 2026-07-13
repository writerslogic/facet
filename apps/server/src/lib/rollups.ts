// Scheduled handler: aggregate raw events into event_rollups (hourly + daily) and enforce
// the raw-event retention window. Invoked by the Cron Trigger. Real logic lands in T024/T025.

import type { Env } from '../env.js';

/** Entrypoint for the cron trigger. Runs rollups then retention cleanup. */
export async function runScheduled(_event: ScheduledController, _env: Env): Promise<void> {
	return;
}
