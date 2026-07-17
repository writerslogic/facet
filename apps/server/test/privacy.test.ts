// Privacy guarantees pinned as tests. If any of these fail, the hashing/ingest design is wrong
// and must be fixed before shipping.

import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { visitorHash } from '../src/lib/hash.js';

const RAW_IP = '198.51.100.42';
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITE = '11111111-1111-4111-8111-111111111111';

function post(siteId: string, headers: Record<string, string> = {}) {
	return createApp().request(
		'/api/collect',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'CF-Connecting-IP': RAW_IP,
				'user-agent': UA,
				...headers,
			},
			body: JSON.stringify({
				site_id: siteId,
				hostname: 'example.com',
				path: '/',
				referrer: '',
			}),
		},
		env,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('privacy guarantees', () => {
	it('never stores the raw IP in any events or sessions column', async () => {
		await post(SITE);
		const events = await env.DB.prepare('SELECT * FROM events WHERE site_id = ?')
			.bind(SITE)
			.all();
		const sessions = await env.DB.prepare('SELECT * FROM sessions WHERE site_id = ?')
			.bind(SITE)
			.all();
		const dump = JSON.stringify([events.results, sessions.results]);
		expect(dump).not.toContain(RAW_IP);
	});

	it('produces different hashes for the same visitor on different days (daily un-linkability)', async () => {
		const day1 = await visitorHash(RAW_IP, UA, 'salt-for-day-one', SITE);
		const day2 = await visitorHash(RAW_IP, UA, 'salt-for-day-two', SITE);
		expect(day1).not.toBe(day2);
	});

	it('emits a 64-char lowercase hex visitor hash', async () => {
		const h = await visitorHash(RAW_IP, UA, 'some-salt', SITE);
		expect(h).toMatch(/^[0-9a-f]{64}$/);
	});

	it('never logs the raw IP while salting and hashing during ingest', async () => {
		const logged: string[] = [];
		for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				logged.push(args.map(String).join(' '));
			});
		}
		await post('22222222-2222-4222-8222-222222222222');
		expect(logged.join('\n')).not.toContain(RAW_IP);
	});
});
