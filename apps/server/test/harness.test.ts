import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('test harness', () => {
	it('has a D1 binding', () => {
		expect(env.DB).toBeDefined();
	});

	it('has 10 tables after migrations', async () => {
		const result = await env.DB.prepare(
			"SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%'",
		).first<{ n: number }>();
		expect(result?.n).toBe(10);
	});

	it('events table has 15 columns', async () => {
		const result = await env.DB.prepare('PRAGMA table_info(events)').all<{
			name: string;
		}>();
		expect(result.results.length).toBe(15);
	});
});
