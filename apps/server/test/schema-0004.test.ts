import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('experiment schema migrations', () => {
	it('experiments table exists with the declared columns', async () => {
		const result = await env.DB.prepare('PRAGMA table_info(experiments)').all<{
			name: string;
			notnull: number;
			dflt_value: string | null;
		}>();
		const names = result.results.map((r) => r.name);
		for (const col of [
			'id',
			'site_id',
			'name',
			'flag_key',
			'variants',
			'status',
			'active',
			'started_at',
			'completed_at',
			'created_at',
		]) {
			expect(names).toContain(col);
		}
		expect(result.results).toHaveLength(10);
		expect(result.results.find((column) => column.name === 'status')).toMatchObject({
			notnull: 1,
			dflt_value: "'active'",
		});
	});

	it('the site index exists', async () => {
		const result = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_experiments_site'",
		).all<{ name: string }>();
		expect(result.results).toHaveLength(1);
	});
});
