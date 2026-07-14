// T014: POST /api/collect — valid beacon writes one event + session, bots are dropped, malformed
// bodies are rejected, and repeat visits in a UTC day yield many events but one session.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_BOT = '22222222-2222-4222-8222-222222222222';
const SITE_REP = '33333333-3333-4333-8333-333333333333';

function post(body: string, headers: Record<string, string> = {}) {
	return createApp().request(
		'/api/collect',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'CF-Connecting-IP': '203.0.113.7',
				'user-agent': CHROME,
				...headers,
			},
			body,
		},
		env,
	);
}

function validPayload(siteId: string) {
	return JSON.stringify({
		site_id: siteId,
		hostname: 'example.com',
		path: '/pricing',
		referrer: '',
	});
}

async function eventCount(siteId: string): Promise<number> {
	const row = await env.DB.prepare('SELECT count(*) as count FROM events WHERE site_id = ?')
		.bind(siteId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

describe('POST /api/collect', () => {
	it('writes one event and one session for a valid beacon', async () => {
		const res = await post(validPayload(SITE_A));
		expect(res.status).toBe(202);
		expect(await res.text()).toBe('');

		const event = await env.DB.prepare(
			'SELECT site_id, path, visitor_hash FROM events WHERE site_id = ?',
		)
			.bind(SITE_A)
			.first<{ site_id: string; path: string; visitor_hash: string }>();
		expect(event?.path).toBe('/pricing');
		expect(event?.visitor_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await eventCount(SITE_A)).toBe(1);

		const session = await env.DB.prepare(
			'SELECT count(*) as count FROM sessions WHERE site_id = ?',
		)
			.bind(SITE_A)
			.first<{ count: number }>();
		expect(session?.count).toBe(1);
	});

	it('drops bot traffic without inserting an event', async () => {
		const res = await post(validPayload(SITE_BOT), {
			'user-agent': 'Googlebot/2.1',
		});
		expect(res.status).toBe(202);
		expect(await eventCount(SITE_BOT)).toBe(0);
	});

	it('rejects a malformed body with 400 validation_failed', async () => {
		const res = await post('{ not valid json');
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'validation_failed' });
	});

	it('rejects a schema-invalid body with 400 validation_failed', async () => {
		const res = await post(JSON.stringify({ hostname: 'example.com', path: '/' }));
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: 'validation_failed',
		});
	});

	it('counts repeat visits in a day as many events but one session', async () => {
		await post(validPayload(SITE_REP));
		await post(validPayload(SITE_REP));
		expect(await eventCount(SITE_REP)).toBe(2);
		const session = await env.DB.prepare(
			'SELECT count(*) as count FROM sessions WHERE site_id = ?',
		)
			.bind(SITE_REP)
			.first<{ count: number }>();
		expect(session?.count).toBe(1);
	});
});
