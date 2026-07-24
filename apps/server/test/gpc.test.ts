// Global Privacy Control: a `Sec-GPC: 1` request signal no longer drops the request — an anonymous,
// cookieless pageview carries no personal data, so both the public beacon (/api/collect) and the
// authenticated first-party endpoint (/api/event) still COUNT it (accurate total traffic). GPC forces
// the anonymous Tier-0 hash downstream, so the visitor is never identity-elevated.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { issueKey } from '../src/lib/apikeys.js';
import { isGpcOptOut } from '../src/lib/gpc.js';

const CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SITE_COLLECT = '44444444-4444-4444-8444-444444444444';
const SITE_EVENT = '55555555-5555-4555-8555-555555555555';

async function eventCount(siteId: string): Promise<number> {
	const row = await env.DB.prepare('SELECT count(*) AS n FROM events WHERE site_id = ?')
		.bind(siteId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

function collect(headers: Record<string, string>) {
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
			body: JSON.stringify({
				site_id: SITE_COLLECT,
				hostname: 'example.com',
				path: '/pricing',
				referrer: '',
				name: 'experiment_exposure',
				props: { flag_key: 'checkout', variant: 'b' },
			}),
		},
		env,
	);
}

describe('isGpcOptOut', () => {
	it('is true only for the exact `Sec-GPC: 1` signal', () => {
		const mk = (h: Record<string, string>) => new Request('https://x/', { headers: h });
		expect(isGpcOptOut(mk({ 'Sec-GPC': '1' }))).toBe(true);
		expect(isGpcOptOut(mk({ 'Sec-GPC': '0' }))).toBe(false);
		expect(isGpcOptOut(mk({ 'Sec-GPC': 'true' }))).toBe(false);
		expect(isGpcOptOut(mk({}))).toBe(false);
	});
});

describe('GPC on /api/collect', () => {
	it('still counts the beacon under GPC (anonymous, cookieless — accurate total traffic)', async () => {
		const res = await collect({ 'Sec-GPC': '1' });
		expect(res.status).toBe(202);
		expect(await res.text()).toBe('');
		expect(await eventCount(SITE_COLLECT)).toBe(1);
	});

	it('ingests normally without the GPC signal', async () => {
		const res = await collect({});
		expect(res.status).toBe(202);
		expect(await eventCount(SITE_COLLECT)).toBe(1);
	});
});

describe('GPC on /api/event', () => {
	let key: string;
	beforeEach(async () => {
		key = (await issueKey(env, SITE_EVENT, null, Date.now())).key;
	});

	function post(headers: Record<string, string>) {
		return createApp().request(
			'/api/event',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					Authorization: `Bearer ${key}`,
					...headers,
				},
				body: JSON.stringify({
					hostname: 'shop.example.com',
					path: '/checkout',
					user_agent: CHROME,
				}),
			},
			env,
		);
	}

	it('still counts the event under GPC (anonymously — never identity-elevated)', async () => {
		const res = await post({ 'Sec-GPC': '1' });
		expect(res.status).toBe(202);
		expect(await eventCount(SITE_EVENT)).toBe(1);
	});

	it('ingests normally without the GPC signal', async () => {
		const res = await post({});
		expect(res.status).toBe(202);
		expect(await eventCount(SITE_EVENT)).toBe(1);
	});
});
