import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('migration 0003 — goals & funnels', () => {
	it('goals table exists with the declared columns', async () => {
		const result = await env.DB.prepare('PRAGMA table_info(goals)').all<{
			name: string;
		}>();
		const names = result.results.map((r) => r.name);
		for (const col of ['id', 'site_id', 'name', 'type', 'match_value', 'created_at']) {
			expect(names).toContain(col);
		}
		expect(result.results).toHaveLength(6);
	});

	it('funnels table exists with the declared columns', async () => {
		const result = await env.DB.prepare('PRAGMA table_info(funnels)').all<{
			name: string;
		}>();
		const names = result.results.map((r) => r.name);
		for (const col of ['id', 'site_id', 'name', 'steps', 'created_at']) {
			expect(names).toContain(col);
		}
		expect(result.results).toHaveLength(5);
	});

	it('the site indexes exist', async () => {
		const result = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_goals_site','idx_funnels_site')",
		).all<{ name: string }>();
		expect(result.results).toHaveLength(2);
	});
});
