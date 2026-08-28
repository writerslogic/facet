// Worker entrypoint: wires the Hono app (HTTP) and the scheduled handler (cron rollups).

import { createApp } from './app.js';
import type { Env } from './env.js';
import { alertsJob } from './lib/alerts.js';
import { type DerivedEvent, persistDerived } from './lib/ingest.js';
import { createLogger } from './lib/log.js';
import { registerJob, runScheduled } from './lib/scheduled.js';

const app = createApp();

// Anomaly + metric alerting rides the EXISTING hourly cron — no second schedule. Registered here through the
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

	// Ingest queue consumer: try the whole batch as one D1 round-trip first (the common case).
	// Persistence is idempotent (id minted at derive time + onConflictDoNothing), so a retry can never
	// duplicate an event. `persistEvents` batches every message into one D1 transaction, so a single
	// poisoned row (a constraint violation, an oversized value) fails all of them together — the
	// fallback below isolates messages one at a time so only the actual bad one is retried/dead-lettered
	// instead of the other ~99 real events in the batch going down with it.
	async queue(batch: MessageBatch<DerivedEvent>, env: Env): Promise<void> {
		const log = createLogger({ handler: 'queue' });
		try {
			await persistDerived(
				env,
				batch.messages.map((m) => m.body),
			);
			return;
		} catch (err) {
			log.error('batch_persist_failed', err instanceof Error ? err : String(err), {
				batch_size: batch.messages.length,
			});
		}
		for (const message of batch.messages) {
			try {
				await persistDerived(env, [message.body]);
				message.ack();
			} catch (err) {
				log.error('message_persist_failed', err instanceof Error ? err : String(err), {
					event_id: message.body.id,
				});
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env, DerivedEvent>;
