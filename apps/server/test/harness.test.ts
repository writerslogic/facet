import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('test harness', () => {
	it('has a D1 binding', () => {
		expect(env.DB).toBeDefined();
	});

	it('has 15 tables after migrations', async () => {
		const result = await env.DB.prepare(
			"SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
		).first<{ n: number }>();
		expect(result?.n).toBe(15);
	});

	it('events table has 15 columns', async () => {
		const result = await env.DB.prepare('PRAGMA table_info(events)').all<{
			name: string;
		}>();
		expect(result.results.length).toBe(15);
	});
});
