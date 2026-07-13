import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.js';
import { writePerf } from '../src/lib/ae.js';

describe('writePerf', () => {
	it('emits the fixed datapoint shape', () => {
		const writeDataPoint = vi.fn();
		const env = {
			AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
		} as unknown as Env;

		writePerf(env, {
			siteId: 'site_123',
			hostname: 'example.com',
			path: '/pricing',
			metric: 'ttfb',
			value: 42.5,
		});

		expect(writeDataPoint).toHaveBeenCalledTimes(1);
		expect(writeDataPoint).toHaveBeenCalledWith({
			indexes: ['site_123'],
			blobs: ['example.com', '/pricing', 'ttfb'],
			doubles: [42.5],
		});
	});
});
