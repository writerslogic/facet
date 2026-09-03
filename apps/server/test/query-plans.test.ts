// Index-plan regression tests for the largest unbounded tables. Row-count fixtures can prove a
// query is correct, but EXPLAIN pins the access path that keeps it affordable once D1 holds millions
// of events, sessions, and immutable rollups.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

async function plan(sql: string, ...values: unknown[]): Promise<string> {
	const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.bind(...values)
		.all<{ detail: string }>();
	return result.results.map(({ detail }) => detail).join('\n');
}

describe('D1 query plans', () => {
	it('range-seeks site events for stats reads', async () => {
		const detail = await plan(
			'SELECT name, COUNT(*) FROM events WHERE site_id = ? AND created_at >= ? AND created_at < ? GROUP BY name',
			'site',
			0,
			1_000,
		);
		expect(detail).toContain('idx_events_site_created_name');
		expect(detail).not.toMatch(/SCAN events/i);
	});

	it('seeks visitor histories used by conversion and experiment queries', async () => {
		const detail = await plan(
			'SELECT id FROM events WHERE site_id = ? AND visitor_hash = ? AND created_at >= ? AND created_at < ?',
			'site',
			'visitor',
			0,
			1_000,
		);
		expect(detail).toContain('idx_events_site_visitor_created');
		expect(detail).not.toMatch(/SCAN events/i);
	});

	it('uses global time indexes for retention purges', async () => {
		const [events, sessions, visits] = await Promise.all([
			plan('DELETE FROM events WHERE created_at < ?', 1_000),
			plan('DELETE FROM sessions WHERE first_seen < ?', 1_000),
			plan('DELETE FROM event_sessions WHERE started_at < ?', 1_000),
		]);
		expect(events).toContain('idx_events_created');
		expect(sessions).toContain('idx_sessions_first_seen');
		expect(visits).toContain('idx_event_sessions_started');
	});

	it('range-seeks finalized rollups for transparency logging', async () => {
		const detail = await plan(
			'SELECT site_id FROM event_rollups WHERE interval = ? AND bucket_start >= ? AND bucket_start < ?',
			'hour',
			0,
			1_000,
		);
		expect(detail).toContain('idx_event_rollups_interval_bucket');
		expect(detail).not.toMatch(/SCAN event_rollups/i);
	});
});
