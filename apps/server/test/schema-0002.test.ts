import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('migration 0002 — sessions & traffic columns', () => {
	it('events table has 15 columns', async () => {
		const result = await env.DB.prepare('PRAGMA table_info(events)').all<{ name: string }>();
		expect(result.results).toHaveLength(15);
		const names = result.results.map((r) => r.name);
		expect(names).toContain('utm_source');
		expect(names).toContain('utm_medium');
		expect(names).toContain('utm_campaign');
		expect(names).toContain('channel');
	});

	it('event_sessions table exists with 13 columns', async () => {
		const result = await env.DB.prepare('PRAGMA table_info(event_sessions)').all<{
			name: string;
		}>();
		expect(result.results).toHaveLength(13);
		const names = result.results.map((r) => r.name);
		for (const col of [
			'id',
			'site_id',
			'visitor_hash',
			'day_key',
			'started_at',
			'ended_at',
			'entry_path',
			'exit_path',
			'channel',
			'pageviews',
			'events',
			'duration_ms',
			'is_bounce',
		]) {
			expect(names).toContain(col);
		}
	});

	it('idx_sessions_site_started index exists', async () => {
		const result = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_site_started'",
		).all<{ name: string }>();
		expect(result.results).toHaveLength(1);
	});
});
