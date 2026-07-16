import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('migration 0004 — experiments', () => {
	it('experiments table exists with the declared columns', async () => {
		const result = await env.DB.prepare('PRAGMA table_info(experiments)').all<{
			name: string;
		}>();
		const names = result.results.map((r) => r.name);
		for (const col of [
			'id',
			'site_id',
			'name',
			'flag_key',
			'variants',
			'active',
			'created_at',
		]) {
			expect(names).toContain(col);
		}
		expect(result.results).toHaveLength(7);
	});

	it('the site index exists', async () => {
		const result = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_experiments_site'",
		).all<{ name: string }>();
		expect(result.results).toHaveLength(1);
	});
});
