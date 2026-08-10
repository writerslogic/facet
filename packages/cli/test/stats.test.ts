// `facet stats` prints summary totals + top paths, and returns 1 when the fetch throws.

import type { StatsResponse } from '@facet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStats } from '../src/commands/stats.js';

const RESPONSE: StatsResponse = {
	summary: { pageviews: 1234, visitors: 567, events: 89 },
	series: [],
	top_paths: [
		{ key: '/', count: 900 },
		{ key: '/pricing', count: 200 },
	],
	top_referrers: [],
	top_events: [],
	top_countries: [],
	top_devices: [],
	engagement: {
		sessions: 0,
		bounce_rate: 0,
		pages_per_session: 0,
		avg_duration_ms: 0,
	},
	channels: [],
};

describe('runStats', () => {
	let stdout: string;
	let stderr: string;
	let outSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stdout = '';
		stderr = '';
		outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
			stdout += String(c);
			return true;
		});
		errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
			stderr += String(c);
			return true;
		});
	});

	afterEach(() => {
		outSpy.mockRestore();
		errSpy.mockRestore();
	});

	it('prints totals and the top paths', async () => {
		const fetchImpl = vi.fn(() => Promise.resolve(RESPONSE));
		const code = await runStats(
			['--host', 'https://a.example.com', '--key', 'clk_x', '--site', 'site-1'],
			fetchImpl as never,
		);
		expect(code).toBe(0);
		expect(stdout).toContain('1234');
		expect(stdout).toContain('567');
		expect(stdout).toContain('89');
		expect(stdout).toContain('/pricing');
	});

	it('refuses a plain-http host without sending the key', async () => {
		const fetchImpl = vi.fn(() => Promise.resolve(RESPONSE));
		const code = await runStats(
			['--host', 'http://a.example.com', '--key', 'clk_x', '--site', 'site-1'],
			fetchImpl as never,
		);
		expect(code).toBe(1);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(stderr).toContain('unencrypted');
	});

	it('encodes the site id into the query rather than interpolating it', async () => {
		const fetchImpl = vi.fn(() => Promise.resolve(RESPONSE));
		await runStats(
			['--host', 'https://a.example.com', '--key', 'clk_x', '--site', 'a&b=c'],
			fetchImpl as never,
		);
		const url = new URL(fetchImpl.mock.calls[0]?.[0] as unknown as string);
		expect(url.searchParams.get('site_id')).toBe('a&b=c');
	});

	it('rejects an unrecognized --range instead of silently substituting the default (exit 1)', async () => {
		const fetchImpl = vi.fn(() => Promise.resolve(RESPONSE));
		const code = await runStats(
			[
				'--host',
				'https://a.example.com',
				'--key',
				'clk_x',
				'--site',
				'site-1',
				'--range',
				'3d',
			],
			fetchImpl as never,
		);
		expect(code).toBe(1);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(stderr).toContain('--range must be one of');
		expect(stderr).toContain('3d');
	});

	it('returns 1 when the request fails', async () => {
		const fetchImpl = vi.fn(() => Promise.reject(new Error('invalid_api_key')));
		const code = await runStats(
			['--host', 'https://a.example.com', '--key', 'bad', '--site', 'site-1'],
			fetchImpl as never,
		);
		expect(code).toBe(1);
		expect(stderr).toContain('invalid_api_key');
	});
});
