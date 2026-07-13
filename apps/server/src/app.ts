// Hono app factory: mounts the ingest beacon and the API-key-authenticated stats routes.

import { Hono } from 'hono';
import type { Env } from './env.js';
import { collectRoute } from './routes/collect.js';
import { statsRoutes } from './routes/stats.js';

export function createApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();

	app.get('/api/health', (c) => c.json({ ok: true }));

	app.route('/api/collect', collectRoute);
	app.route('/api', statsRoutes);

	return app;
}
