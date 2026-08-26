// The two unauthenticated /api/auth routes are rate-limited per client IP. /request is the one that
// matters most: it writes an auth_tokens row for any well-formed email an anonymous caller offers,
// and it cannot check first whether that address has an account without leaking that it does.
//
// The buckets are separate on purpose, so the tests below pin that separation rather than just the
// presence of a limit — sharing one bucket would let a /request flood from an office NAT lock every
// operator behind it out of redeeming a link they legitimately received.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';

const IP_A = '203.0.113.7';
const IP_B = '198.51.100.9';

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

function post(path: string, body: unknown, ip: string | null, limiter: Env['RATE_LIMITER']) {
	const sender = { send: async () => ({ success: true }) } as unknown as SendEmail;
	return createApp().request(
		path,
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(ip ? { 'CF-Connecting-IP': ip } : {}),
			},
			body: JSON.stringify(body),
		},
		{
			...env,
			RATE_LIMITER: limiter,
			SESSION_SECRET: 'test-secret',
			SEND_EMAIL: sender,
			AUTH_EMAIL_FROM: 'facet@example.com',
		} as Env,
	);
}

const request = (
	ip: string | null,
	limiter: Env['RATE_LIMITER'],
	body: unknown = { email: 'a@example.com' },
) => post('/api/auth/request', body, ip, limiter);

const verify = (ip: string | null, limiter: Env['RATE_LIMITER']) =>
	post('/api/auth/verify', { token: 'aaaaaaaa.bogus' }, ip, limiter);

async function tokenCount(): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_tokens').first<{
		n: number;
	}>();
	return row?.n ?? 0;
}

describe('POST /api/auth/request rate limiting', () => {
	it('allows traffic under the limit and keys the bucket by client IP', async () => {
		const { limiter, seen } = makeLimiter();
		expect((await request(IP_A, limiter)).status).toBe(202);
		expect(seen).toEqual([`auth-request:${IP_A}`]);
	});

	it('rejects a denied bucket with 429 + Retry-After, and writes no token row', async () => {
		const before = await tokenCount();
		const { limiter } = makeLimiter(new Set([`auth-request:${IP_A}`]));
		const res = await request(IP_A, limiter);
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('60');
		expect(await res.json()).toEqual({ error: 'rate_limited' });
		// The point of the limit: the row the route would otherwise have inserted is not there. A 429
		// that still wrote would bound nothing.
		expect(await tokenCount()).toBe(before);
	});

	it('isolates buckets between IPs', async () => {
		const { limiter, seen } = makeLimiter(new Set([`auth-request:${IP_A}`]));
		expect((await request(IP_A, limiter)).status).toBe(429);
		expect((await request(IP_B, limiter)).status).toBe(202);
		expect(seen).toEqual([`auth-request:${IP_A}`, `auth-request:${IP_B}`]);
	});

	it('charges the bucket before parsing the body, so malformed floods are limited too', async () => {
		// Ordering check, not a validation check: the limiter runs ahead of the validator, so a caller
		// spraying unparseable bodies is charged rather than waved through to a free 400 every time.
		const { limiter, seen } = makeLimiter();
		expect((await request(IP_A, limiter, { email: 'not-an-email' })).status).toBe(400);
		expect(seen).toEqual([`auth-request:${IP_A}`]);
	});
});

describe('POST /api/auth/verify rate limiting', () => {
	it('keys its own bucket by client IP', async () => {
		const { limiter, seen } = makeLimiter();
		expect((await verify(IP_A, limiter)).status).toBe(401);
		expect(seen).toEqual([`auth-verify:${IP_A}`]);
	});

	it('rejects a denied bucket with 429', async () => {
		const { limiter } = makeLimiter(new Set([`auth-verify:${IP_A}`]));
		expect((await verify(IP_A, limiter)).status).toBe(429);
	});

	it('does not share a bucket with /request: exhausting one leaves the other usable', async () => {
		// The separation that keeps a /request flood from denying a legitimate operator behind the same
		// NAT the ability to redeem the link they already hold. 401 here is the token being bogus — the
		// request reached the handler, which is the whole assertion.
		const { limiter } = makeLimiter(new Set([`auth-request:${IP_A}`]));
		expect((await request(IP_A, limiter)).status).toBe(429);
		expect((await verify(IP_A, limiter)).status).toBe(401);
	});
});
