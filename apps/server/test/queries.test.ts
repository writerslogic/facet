// Event insert (props JSON round-trip, UUID id) and idempotent session upsert.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { type NewEvent, insertEvent, upsertSession } from '../src/db/queries.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newEvent(overrides: Partial<NewEvent> = {}): NewEvent {
	return {
		siteId: 'site-1',
		hostname: 'example.com',
		path: '/pricing',
		referrer: '',
		name: 'signup',
		props: { plan: 'pro', trial: true },
		visitorHash: 'a'.repeat(64),
		country: 'US',
		device: 'desktop',
		createdAt: 1_700_000_000_000,
		...overrides,
	};
}

describe('insertEvent', () => {
	it('returns a UUID and round-trips props through JSON', async () => {
		const id = await insertEvent(env, newEvent());
		expect(id).toMatch(UUID_RE);
		const row = await env.DB.prepare('SELECT props FROM events WHERE id = ?')
			.bind(id)
			.first<{ props: string }>();
		expect(JSON.parse(row?.props ?? 'null')).toEqual({
			plan: 'pro',
			trial: true,
		});
	});

	it('stores null props when none are given', async () => {
		const id = await insertEvent(env, newEvent({ props: null }));
		const row = await env.DB.prepare('SELECT props FROM events WHERE id = ?')
			.bind(id)
			.first<{ props: string | null }>();
		expect(row?.props).toBeNull();
	});
});

describe('upsertSession', () => {
	it('leaves exactly one row for a repeated (site, visitor, day)', async () => {
		await upsertSession(env, 'site-1', 'v-hash', '2026-01-02', 1_700_000_000_000);
		await upsertSession(env, 'site-1', 'v-hash', '2026-01-02', 1_700_000_999_999);
		const row = await env.DB.prepare(
			'SELECT count(*) as count FROM sessions WHERE site_id = ? AND visitor_hash = ? AND day_key = ?',
		)
			.bind('site-1', 'v-hash', '2026-01-02')
			.first<{ count: number }>();
		expect(row?.count).toBe(1);
	});
});
