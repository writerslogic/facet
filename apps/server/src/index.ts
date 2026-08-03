// Worker entrypoint: wires the Hono app (HTTP) and the scheduled handler (cron rollups).

import { createApp } from './app.js';
import type { Env } from './env.js';
import { alertsJob } from './lib/alerts.js';
import { type DerivedEvent, persistDerived } from './lib/ingest.js';
import { registerJob, runScheduled } from './lib/scheduled.js';

const app = createApp();

// Anomaly alerting rides the EXISTING hourly cron — no second schedule. Registered here through the
// job registry's own extension point, so it gets the same per-job try/catch isolation as rollups and
// retention: a broken webhook endpoint can never stop aggregation from running.
registerJob(alertsJob);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		return app.fetch(request, env, ctx);
	},

	scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(runScheduled(event, env));
	},

	// Ingest queue consumer: persist a whole batch of derived events in one D1 round-trip. Persistence is
	// idempotent (id minted at derive time + onConflictDoNothing), so throwing to retry the at-least-once
	// batch can never duplicate an event.
	async queue(batch: MessageBatch<DerivedEvent>, env: Env): Promise<void> {
		await persistDerived(
			env,
			batch.messages.map((m) => m.body),
		);
	},
} satisfies ExportedHandler<Env, DerivedEvent>;
