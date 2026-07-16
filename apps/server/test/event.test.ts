// First-party server-to-server events: POST /api/event authenticated by API key writes an event
// scoped to the key's site, drops bots, and rejects missing/invalid auth.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { issueKey } from '../src/lib/apikeys.js';

const SITE = '11111111-1111-4111-8111-111111111111';
let key: string;

function post(body: Record<string, unknown>, apiKey: string | null) {
	return createApp().request(
		'/api/event',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify(body),
		},
		env,
	);
}

async function eventCount(): Promise<number> {
	const row = await env.DB.prepare('SELECT count(*) AS n FROM events WHERE site_id = ?')
		.bind(SITE)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

beforeEach(async () => {
	key = (await issueKey(env, SITE, null, Date.now())).key;
});

describe('POST /api/event', () => {
	it('ingests a server event scoped to the key site', async () => {
		const res = await post(
			{
				hostname: 'shop.example.com',
				path: '/checkout',
				referrer: 'https://google.com/',
				name: 'purchase',
				props: { amount: 42 },
				ip: '203.0.113.9',
				user_agent: 'Mozilla/5.0 (Macintosh) Chrome/120.0.0.0',
			},
			key,
		);
		expect(res.status).toBe(202);
		expect(await eventCount()).toBe(1);
		const row = await env.DB.prepare(
			'SELECT path, name, channel, visitor_hash FROM events WHERE site_id = ?',
		)
			.bind(SITE)
			.first<{
				path: string;
				name: string;
				channel: string;
				visitor_hash: string;
			}>();
		expect(row?.path).toBe('/checkout');
		expect(row?.name).toBe('purchase');
		expect(row?.channel).toBe('organic');
		expect(row?.visitor_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('drops a bot user_agent without inserting', async () => {
		const res = await post(
			{ hostname: 'shop.example.com', path: '/', user_agent: 'Googlebot/2.1' },
			key,
		);
		expect(res.status).toBe(202);
		expect(await eventCount()).toBe(0);
	});

	it('rejects a missing API key with 401', async () => {
		const res = await post({ hostname: 'shop.example.com', path: '/' }, null);
		expect(res.status).toBe(401);
	});

	it('rejects a schema-invalid body with 400', async () => {
		const res = await post({ hostname: 'shop.example.com', path: 'no-leading-slash' }, key);
		expect(res.status).toBe(400);
	});
});
