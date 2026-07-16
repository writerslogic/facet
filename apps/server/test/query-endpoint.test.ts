// POST /api/stats/query route guards, exercised without an AI binding: the happy path returns
// 503 ai_unavailable (no AI in the test env), and site/question validation reject before that.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const T0 = Date.parse('2026-04-01T00:00:00.000Z');
const DAY = 86_400_000;

async function setup(): Promise<{ siteId: string; key: string }> {
	const siteRes = await app.request(
		'/api/sites',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Acme', domain: 'acme.com' }),
		},
		env,
	);
	const { site } = (await siteRes.json()) as { site: { id: string } };
	const keyRes = await app.request(
		'/api/keys',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({ site_id: site.id }),
		},
		env,
	);
	const { key } = (await keyRes.json()) as { key: string };
	return { siteId: site.id, key };
}

function post(key: string, body: unknown) {
	return app.request(
		'/api/stats/query',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${key}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		},
		env,
	);
}

describe('POST /api/stats/query guards', () => {
	it('returns 503 ai_unavailable when no AI binding is present', async () => {
		const { siteId, key } = await setup();
		const res = await post(key, {
			site_id: siteId,
			question: 'top pages last week',
			start: T0,
			end: T0 + DAY,
		});
		expect(res.status).toBe(503);
		expect((await res.json()) as { error: string }).toEqual({
			error: 'ai_unavailable',
		});
	});

	it('rejects a mismatched site with 403', async () => {
		const { key } = await setup();
		const res = await post(key, {
			site_id: '00000000-0000-4000-8000-000000000000',
			question: 'top pages',
			start: T0,
			end: T0 + DAY,
		});
		expect(res.status).toBe(403);
	});

	it('rejects an empty question with 400', async () => {
		const { siteId, key } = await setup();
		const res = await post(key, {
			site_id: siteId,
			question: '',
			start: T0,
			end: T0 + DAY,
		});
		expect(res.status).toBe(400);
	});
});
