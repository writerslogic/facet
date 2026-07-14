import { describe, it, expect, vi } from 'vitest';
import { writePerf } from '../src/lib/ae.js';
import type { Env } from '../src/env.js';

function makeEnv(): { env: Env; writeDataPoint: ReturnType<typeof vi.fn> } {
    const writeDataPoint = vi.fn();
    const env = {
        AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    } as unknown as Env;
    return { env, writeDataPoint };
}

describe('writePerf', () => {
    it('calls writeDataPoint with correct indexes, blobs, and doubles', () => {
        const { env, writeDataPoint } = makeEnv();
        writePerf(env, {
            siteId: 'site-1',
            hostname: 'example.com',
            path: '/home',
            metric: 'LCP',
            value: 1234.5,
        });
        expect(writeDataPoint).toHaveBeenCalledOnce();
        expect(writeDataPoint).toHaveBeenCalledWith({
            indexes: ['site-1'],
            blobs: ['example.com', '/home', 'LCP'],
            doubles: [1234.5],
        });
    });

    it('uses the provided siteId as the sole index', () => {
        const { env, writeDataPoint } = makeEnv();
        writePerf(env, {
            siteId: 'abc',
            hostname: 'test.io',
            path: '/about',
            metric: 'FID',
            value: 0,
        });
        const call = writeDataPoint.mock.calls[0]?.[0] as { indexes: string[] };
        expect(call.indexes).toEqual(['abc']);
    });
});
