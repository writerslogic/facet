// Phase 2 privacy review: UTM values live only in their declared columns, and derived sessions
// carry no raw IP/UA and a non-reversible id.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { dayKey } from '../src/lib/salt.js';
import { buildSessions } from '../src/lib/sessions.js';

const RAW_IP = '198.51.100.77';
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITE = '11111111-1111-4111-8111-111111111111';

async function collect(): Promise<void> {
	await createApp().request(
		'/api/collect',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'CF-Connecting-IP': RAW_IP,
				'user-agent': UA,
			},
			body: JSON.stringify({
				site_id: SITE,
				hostname: 'example.com',
				path: '/',
				referrer: '',
				utm: { source: 'newsletter', medium: 'email', campaign: 'launch' },
			}),
		},
		env,
	);
}

describe('phase 2 privacy', () => {
	it('stores UTM verbatim only in its declared columns', async () => {
		await collect();
		const row = await env.DB.prepare('SELECT * FROM events WHERE site_id = ?')
			.bind(SITE)
			.first<Record<string, unknown>>();
		expect(row?.utm_source).toBe('newsletter');
		expect(row?.utm_medium).toBe('email');
		expect(row?.utm_campaign).toBe('launch');
		// The campaign token must not have leaked into any non-utm column.
		for (const [col, value] of Object.entries(row ?? {})) {
			if (col === 'utm_campaign') continue;
			expect(String(value ?? '')).not.toContain('launch');
		}
	});

	it('derives sessions with no raw IP/UA and a non-reversible id', async () => {
		await collect();
		const written = await buildSessions(env, dayKey(Date.now()));
		expect(written).toBeGreaterThanOrEqual(1);
		const session = await env.DB.prepare('SELECT * FROM event_sessions WHERE site_id = ?')
			.bind(SITE)
			.first<Record<string, unknown>>();
		const dump = JSON.stringify(session);
		expect(dump).not.toContain(RAW_IP);
		expect(dump).not.toContain(UA);
		expect(String(session?.id)).toMatch(/^[0-9a-f]{64}$/);
	});
});
