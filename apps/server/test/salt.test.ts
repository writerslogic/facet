// T008: daily salt — stable per UTC day (one row, race-safe), distinct across days.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dayKey, getDailySalt } from '../src/lib/salt.js';

async function saltRowCount(): Promise<number> {
	const row = await env.DB.prepare('SELECT count(*) as count FROM salts').first<{
		count: number;
	}>();
	return row?.count ?? 0;
}

describe('dayKey', () => {
	it('is the UTC YYYY-MM-DD for a timestamp', () => {
		expect(dayKey(0)).toBe('1970-01-01');
		expect(dayKey(Date.UTC(2026, 6, 13, 23, 59))).toBe('2026-07-13');
	});
});

describe('getDailySalt', () => {
	it('returns the same 64-hex salt for the same day and creates exactly one row', async () => {
		const now = Date.UTC(2026, 0, 2, 12);
		const a = await getDailySalt(env, '2026-01-02', now);
		const b = await getDailySalt(env, '2026-01-02', now + 5000);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(b).toBe(a);
		expect(await saltRowCount()).toBe(1);
	});

	it('yields a different salt for a different day', async () => {
		const now = Date.UTC(2026, 0, 3, 12);
		const a = await getDailySalt(env, '2026-01-03', now);
		const b = await getDailySalt(env, '2026-01-04', now);
		expect(b).not.toBe(a);
	});
});
