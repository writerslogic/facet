import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedEvents, seedSite } from './fixtures.js';

describe('test harness', () => {
	it('has 6 tables after migrations', async () => {
		const result = await env.DB.prepare(
			`SELECT count(*) as count FROM sqlite_master
			 WHERE type='table'
			   AND name NOT LIKE 'sqlite_%'
			   AND name NOT LIKE '_cf_%'
			   AND name != 'd1_migrations'`,
		).first<{ count: number }>();
		expect(result?.count).toBe(6);
	});

	it('seedSite inserts a site row', async () => {
		const { siteId } = await seedSite(env);
		const row = await env.DB.prepare('SELECT id FROM sites WHERE id = ?')
			.bind(siteId)
			.first<{ id: string }>();
		expect(row?.id).toBe(siteId);
	});

	it('seedEvents inserts the expected number of event rows', async () => {
		const { siteId } = await seedSite(env);
		const baseTs = 1_700_000_000_000;
		await seedEvents(env, { siteId, count: 5, baseTs });
		const row = await env.DB.prepare('SELECT count(*) as count FROM events WHERE site_id = ?')
			.bind(siteId)
			.first<{ count: number }>();
		expect(row?.count).toBe(5);
	});
});
