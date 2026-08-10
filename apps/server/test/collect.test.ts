// POST /api/collect: valid beacon writes one event + session, bots are dropped, malformed bodies
// are rejected, and repeat visits in a UTC day yield many events but one session.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_BOT = '22222222-2222-4222-8222-222222222222';
const SITE_REP = '33333333-3333-4333-8333-333333333333';
const SITE_SEG = '44444444-4444-4444-8444-444444444444';
const SITE_REV = '55555555-5555-4555-8555-555555555555';

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

function validPayload(siteId: string, path = '/pricing') {
	return JSON.stringify({
		site_id: siteId,
		hostname: 'example.com',
		path,
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

	it('derives + stores segmentation from client hints and coarse body fields, and requests hints', async () => {
		const res = await post(
			JSON.stringify({
				site_id: SITE_SEG,
				hostname: 'example.com',
				path: '/',
				referrer: '',
				screen: 'laptop',
				orientation: 'landscape',
				dpr: '2x',
			}),
			{
				'sec-ch-ua': '"Chromium";v="120", "Not:A-Brand";v="24", "Google Chrome";v="120"',
				'sec-ch-ua-platform': '"Windows"',
				'sec-ch-ua-mobile': '?0',
				'accept-language': 'en-US,en;q=0.9',
			},
		);
		expect(res.status).toBe(202);
		// The response advertises the low-entropy UA client hints for subsequent beacons.
		expect(res.headers.get('Accept-CH')).toContain('Sec-CH-UA-Platform');

		const row = await env.DB.prepare(
			'SELECT browser, os, form_factor, language, screen_tier, orientation, dpr_class FROM events WHERE site_id = ?',
		)
			.bind(SITE_SEG)
			.first<Record<string, string | null>>();
		expect(row).toMatchObject({
			browser: 'Chrome',
			os: 'Windows',
			form_factor: 'desktop',
			language: 'en',
			screen_tier: 'laptop',
			orientation: 'landscape',
			dpr_class: '2x',
		});
	});

	it('lifts props.revenue/currency into the typed value + currency columns', async () => {
		const res = await post(
			JSON.stringify({
				site_id: SITE_REV,
				hostname: 'shop.test',
				path: '/checkout',
				referrer: '',
				name: 'purchase',
				props: { revenue: 49.99, currency: 'usd' },
			}),
		);
		expect(res.status).toBe(202);
		const row = await env.DB.prepare(
			'SELECT value, currency, name FROM events WHERE site_id = ?',
		)
			.bind(SITE_REV)
			.first<{ value: number; currency: string; name: string }>();
		expect(row?.name).toBe('purchase');
		expect(row?.value).toBeCloseTo(49.99);
		expect(row?.currency).toBe('USD');
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
		// Different paths: two genuinely distinct pageviews, not two beacons of the same content.
		await post(validPayload(SITE_REP, '/pricing'));
		await post(validPayload(SITE_REP, '/docs'));
		expect(await eventCount(SITE_REP)).toBe(2);
		const session = await env.DB.prepare(
			'SELECT count(*) as count FROM sessions WHERE site_id = ?',
		)
			.bind(SITE_REP)
			.first<{ count: number }>();
		expect(session?.count).toBe(1);
	});

	it('collapses two back-to-back identical beacons (client double-boot) into one event', async () => {
		const SITE_DUP = '66666666-6666-4666-8666-666666666666';
		await post(validPayload(SITE_DUP, '/checkout'));
		await post(validPayload(SITE_DUP, '/checkout'));
		expect(await eventCount(SITE_DUP)).toBe(1);
	});
});
