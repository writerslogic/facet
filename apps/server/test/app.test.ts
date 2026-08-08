// App shell: canonical error envelope, JSON 404, scoped CORS on the beacon, oversized-body rejection.

import { env } from 'cloudflare:test';
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
