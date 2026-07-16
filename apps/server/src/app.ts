// Hono app factory. Applies the canonical error envelope, scoped CORS + body limit for the
// public beacon, and a JSON 404, then mounts every sub-router from the route registry.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './env.js';
import { COLLECT_MAX_BODY_BYTES, CORS_MAX_AGE } from './lib/constants.js';
import { ApiError, toErrorBody } from './lib/http.js';
import { ROUTES } from './routes/registry.js';

export function createApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	// Public beacon only: any origin may POST, and oversized bodies are rejected before parsing.
	app.use(
		'/api/collect',
		cors({
			origin: '*',
			allowMethods: ['POST', 'OPTIONS'],
			allowHeaders: ['content-type'],
			maxAge: CORS_MAX_AGE,
		}),
	);
	app.use(
		'/api/collect',
		bodyLimit({
			maxSize: COLLECT_MAX_BODY_BYTES,
			onError: () => {
				throw new ApiError('payload_too_large', 413);
			},
		}),
	);

	for (const { path, router } of ROUTES) {
		app.route(path, router);
	}

	// Everything that is not an API route is served from the built dashboard assets. A navigation
	// request that misses a real file falls back to index.html so client-side routes resolve (SPA).
	app.get('*', async (c) => {
		const { pathname } = new URL(c.req.url);
		if (pathname.startsWith('/api/')) {
			return c.json({ error: 'not_found' }, 404);
		}
		const res = await c.env.ASSETS.fetch(c.req.raw);
		if (res.status === 404 && (c.req.header('accept') ?? '').includes('text/html')) {
			const indexUrl = new URL('/index.html', c.req.url);
			return c.env.ASSETS.fetch(new Request(indexUrl, { method: 'GET' }));
		}
		return res;
	});

	app.notFound((c) => c.json({ error: 'not_found' }, 404));
	app.onError((err, c) => {
		if (err instanceof ApiError) {
			return c.json(toErrorBody(err), err.status);
		}
		// A 400 HTTPException here only comes from body parsing (malformed JSON / form).
		if (err instanceof HTTPException && err.status === 400) {
			return c.json({ error: 'validation_failed' }, 400);
		}
		// Never leak an unexpected error's message to the client; details go to logs only.
		return c.json({ error: 'internal_error' }, 500);
	});

	return app;
}
