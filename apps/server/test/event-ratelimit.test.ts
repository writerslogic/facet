// A.3: POST /api/event is rate-limited per authenticated site. Auth runs before the limiter (an
// invalid key never consumes a bucket), a denied bucket returns 429 + Retry-After, and each site's
// key maps to its own bucket so one customer cannot drain another's quota.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { issueKey } from '../src/lib/apikeys.js';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

/** Records every key seen and denies any key in `denyKeys`. */
function makeLimiter(denyKeys: Set<string> = new Set()) {
	const seen: string[] = [];
	const limiter = {
		limit: async ({ key }: { key?: string }) => {
			seen.push(key ?? '');
			return { success: !denyKeys.has(key ?? '') };
		},
	} as Env['RATE_LIMITER'];
	return { limiter, seen };
}

function post(apiKey: string | null, limiter: Env['RATE_LIMITER']) {
	return createApp().request(
		'/api/event',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ hostname: 'shop.example.com', path: '/' }),
		},
		{ ...env, RATE_LIMITER: limiter } as Env,
	);
}

let keyA: string;
let keyB: string;

beforeEach(async () => {
	keyA = (await issueKey(env, SITE_A, null, Date.now())).key;
	keyB = (await issueKey(env, SITE_B, null, Date.now())).key;
});

describe('POST /api/event rate limiting', () => {
	it('allows traffic under the limit and keys the bucket by authenticated site', async () => {
		const { limiter, seen } = makeLimiter();
		const res = await post(keyA, limiter);
		expect(res.status).toBe(202);
		expect(seen).toEqual([`event:${SITE_A}`]);
	});

	it('rejects a denied bucket with 429 + Retry-After', async () => {
		const { limiter } = makeLimiter(new Set([`event:${SITE_A}`]));
		const res = await post(keyA, limiter);
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('60');
		expect(await res.json()).toEqual({ error: 'rate_limited' });
	});

	it('does not consume a bucket for an invalid API key (auth first)', async () => {
		const { limiter, seen } = makeLimiter();
		const res = await post('clk_bogus', limiter);
		expect(res.status).toBe(401);
		expect(seen).toEqual([]);
	});

	it('isolates buckets between sites: denying site A does not affect site B', async () => {
		const { limiter, seen } = makeLimiter(new Set([`event:${SITE_A}`]));
		expect((await post(keyA, limiter)).status).toBe(429);
		expect((await post(keyB, limiter)).status).toBe(202);
		expect(seen).toEqual([`event:${SITE_A}`, `event:${SITE_B}`]);
	});
});
