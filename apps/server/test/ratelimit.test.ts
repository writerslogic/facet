// T013: rate-limit middleware — denies over-limit keys with 429 + Retry-After, isolates keys,
// and no-ops when the RATE_LIMITER binding is absent.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { ApiError, toErrorBody } from '../src/lib/http.js';
import { rateLimit } from '../src/lib/ratelimit.js';

/** A stub limiter that allows the first 100 calls per key and denies from the 101st on. */
function makeLimiter(): Env['RATE_LIMITER'] {
	const counts = new Map<string, number>();
	return {
		limit: async ({ key }: { key?: string }) => {
			const n = (counts.get(key ?? '') ?? 0) + 1;
			counts.set(key ?? '', n);
			return { success: n <= 100 };
		},
	} as Env['RATE_LIMITER'];
}

function makeApp() {
	const app = new Hono<{ Bindings: Env }>();
	app.use(
		'/hit',
		rateLimit((c) => c.req.header('x-key') ?? 'default'),
	);
	app.get('/hit', (c) => c.text('ok'));
	app.onError((err, c) => {
		if (err instanceof ApiError) {
			return c.json(toErrorBody(err), err.status);
		}
		return c.json({ error: 'internal_error' }, 500);
	});
	return app;
}

function hit(app: Hono<{ Bindings: Env }>, key: string, limiter?: Env['RATE_LIMITER']) {
	return app.request('/hit', { headers: { 'x-key': key } }, {
		RATE_LIMITER: limiter,
	} as Env);
}

describe('rateLimit', () => {
	it('denies the 101st request for a key with 429 + Retry-After, isolating other keys', async () => {
		const app = makeApp();
		const limiter = makeLimiter();
		for (let i = 0; i < 100; i++) {
			const ok = await hit(app, 'a', limiter);
			expect(ok.status).toBe(200);
		}
		const denied = await hit(app, 'a', limiter);
		expect(denied.status).toBe(429);
		expect(denied.headers.get('Retry-After')).toBe('60');
		expect(await denied.json()).toEqual({ error: 'rate_limited' });

		const other = await hit(app, 'b', limiter);
		expect(other.status).toBe(200);
	});

	it('is a no-op when RATE_LIMITER is undefined', async () => {
		const res = await hit(makeApp(), 'a', undefined);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});
});
