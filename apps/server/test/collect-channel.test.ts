// The collect handler classifies and persists the traffic channel + UTM columns.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function post(body: Record<string, unknown>) {
	return createApp().request(
		'/api/collect',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'CF-Connecting-IP': '203.0.113.7',
				'user-agent': CHROME,
			},
			body: JSON.stringify(body),
		},
		env,
	);
}

async function row(siteId: string) {
	return env.DB.prepare('SELECT channel, utm_medium FROM events WHERE site_id = ?')
		.bind(siteId)
		.first<{ channel: string | null; utm_medium: string | null }>();
}

describe('collect channel + utm persistence', () => {
	it('stores channel=paid and utm_medium=cpc for a paid utm', async () => {
		const site = '11111111-1111-4111-8111-111111111111';
		const res = await post({
			site_id: site,
			hostname: 'example.com',
			path: '/',
			referrer: '',
			utm: { medium: 'cpc', source: 'google' },
		});
		expect(res.status).toBe(202);
		expect(await row(site)).toEqual({ channel: 'paid', utm_medium: 'cpc' });
	});

	it('stores channel=direct for an empty referrer with no utm', async () => {
		const site = '22222222-2222-4222-8222-222222222222';
		await post({
			site_id: site,
			hostname: 'example.com',
			path: '/',
			referrer: '',
		});
		expect(await row(site)).toEqual({ channel: 'direct', utm_medium: null });
	});
});
