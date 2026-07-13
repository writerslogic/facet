// Worker entrypoint: wires the Hono app (HTTP) and the scheduled handler (cron rollups).

import { createApp } from './app.js';
import type { Env } from './env.js';
import { runScheduled } from './lib/rollups.js';

const app = createApp();

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		return app.fetch(request, env, ctx);
	},

	scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(runScheduled(event, env));
	},
} satisfies ExportedHandler<Env>;
