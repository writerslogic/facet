// App shell: canonical error envelope, JSON 404, scoped CORS on the beacon, oversized-body rejection.

import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('app shell', () => {
	it('GET /api/health → 200 { ok: true }', async () => {
		const res = await createApp().request('/api/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('unknown route → 404 { error: not_found }', async () => {
		const res = await createApp().request('/api/nope');
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not_found' });
	});

	it('OPTIONS /api/collect → 204 preflight allowing any origin', async () => {
		const res = await createApp().request('/api/collect', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://example.com',
				'Access-Control-Request-Method': 'POST',
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
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
