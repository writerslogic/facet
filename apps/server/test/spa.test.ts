// T028: the Worker serves the built dashboard for non-API routes (with SPA fallback), while API
// routes keep returning JSON.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();

function navigate(path: string): Request {
	return new Request(`https://example.com${path}`, {
		method: 'GET',
		headers: { accept: 'text/html' },
	});
}

describe('dashboard serving', () => {
	it('serves the dashboard HTML at the root', async () => {
		const res = await app.fetch(navigate('/'), env);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(await res.text()).toContain('<div id="root">');
	});

	it('falls back to index.html for a client-side route', async () => {
		const res = await app.fetch(navigate('/some/spa/route'), env);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('<div id="root">');
	});

	it('still returns JSON for API routes', async () => {
		const res = await app.fetch(new Request('https://example.com/api/health'), env);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(await res.json()).toEqual({ ok: true });
	});

	it('returns a JSON 404 for unknown API routes (never assets)', async () => {
		const res = await app.fetch(navigate('/api/nope'), env);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not_found' });
	});
});
