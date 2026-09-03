// App shell: canonical error envelope, JSON 404, scoped CORS on the beacon, oversized-body rejection.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('app shell', () => {
	it('GET /api/health → 200 { ok: true }', async () => {
		const res = await createApp().request('/api/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('GET /api/ready is protected rather than exposing configuration', async () => {
		const res = await createApp().request('/api/ready', {}, env);
		expect(res.status).toBe(401);
	});

	it('GET /api/ready detects orphaned relational rows before FK enforcement', async () => {
		await env.DB.prepare('INSERT INTO api_key_scopes (api_key_id, scope) VALUES (?, ?)')
			.bind('missing-key', 'read')
			.run();
		const res = await createApp().request(
			'/api/ready',
			{ headers: { Authorization: 'Bearer test-admin-token' } },
			env,
		);
		expect(res.status).toBe(503);
		const body = await res.json<{ checks: Record<string, boolean> }>();
		expect(body.checks.referentialIntegrity).toBe(false);
	});

	it('sets X-Content-Type-Options: nosniff on every response, including errors and the SPA shell', async () => {
		const app = createApp();
		// A happy-path c.json response.
		expect((await app.request('/api/health')).headers.get('X-Content-Type-Options')).toBe(
			'nosniff',
		);
		// A route that throws an ApiError, which unwinds past the middleware's `next()` — the case
		// that would slip through a naive `await next(); c.header(...)` (no try/finally).
		expect(
			(await app.request('/api/ready', {}, env)).headers.get('X-Content-Type-Options'),
		).toBe('nosniff');
		// The default 404, built by `app.notFound`, not a handler at all.
		expect((await app.request('/api/nope')).headers.get('X-Content-Type-Options')).toBe(
			'nosniff',
		);
		// The SPA catch-all, which already sets this header itself via withDashboardSecurityHeaders —
		// must not be clobbered or duplicated by the global middleware setting it a second time.
		expect((await app.request('/', {}, env)).headers.get('X-Content-Type-Options')).toBe(
			'nosniff',
		);
	});

	it('unknown route → 404 { error: not_found }', async () => {
		const res = await createApp().request('/api/nope');
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not_found' });
	});

	it('OPTIONS /api/collect → 204 preflight reflecting the caller origin', async () => {
		const res = await createApp().request('/api/collect', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://example.com',
				'Access-Control-Request-Method': 'POST',
			},
		});
		expect(res.status).toBe(204);
		// Any origin is still allowed, but the origin is reflected rather than answered with a
		// wildcard: navigator.sendBeacon() sends in credentials mode, and a credentialed request
		// against `*` is rejected by the browser, which silently dropped every cross-origin
		// beacon. See test/cors-cross-origin.test.ts.
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
		expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
	});

	it('POST /api/collect over the body limit → 413 payload_too_large', async () => {
		const body = 'x'.repeat(9000);
		const res = await createApp().request('/api/collect', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': String(body.length),
			},
			body,
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: 'payload_too_large' });
	});
});
