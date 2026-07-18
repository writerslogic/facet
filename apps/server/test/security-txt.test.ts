// RFC 9116 security.txt: served from the Worker at /.well-known/security.txt with the correct
// content type, a future Expires, and Canonical bound to the request origin. The builder is also
// unit-tested for the required fields and future-expiry invariant.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { buildSecurityTxt } from '../src/lib/security-txt.js';

/** Parse `Field: value` lines into a map (last value wins). */
function fields(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of body.split('\n')) {
		const m = line.match(/^([A-Za-z-]+):\s*(.+)$/);
		if (m?.[1] && m[2]) out[m[1]] = m[2];
	}
	return out;
}

describe('buildSecurityTxt', () => {
	it('includes required fields with a future Expires', () => {
		const now = Date.UTC(2026, 0, 1);
		const body = buildSecurityTxt({ origin: 'https://a.example.com', now });
		const f = fields(body);
		expect(f.Contact).toBe('mailto:security@writerslogic.com');
		expect(f.Canonical).toBe('https://a.example.com/.well-known/security.txt');
		expect(f.Policy).toContain('SECURITY.md');
		expect(Date.parse(f.Expires ?? '')).toBeGreaterThan(now);
	});

	it('honors contact/policy overrides', () => {
		const body = buildSecurityTxt({
			origin: 'https://a.example.com',
			contact: 'mailto:sec@op.example',
			policy: 'https://op.example/policy',
			now: Date.UTC(2026, 0, 1),
		});
		const f = fields(body);
		expect(f.Contact).toBe('mailto:sec@op.example');
		expect(f.Policy).toBe('https://op.example/policy');
	});
});

describe('GET /.well-known/security.txt', () => {
	it('serves a valid, unexpired security.txt as text/plain', async () => {
		const res = await createApp().request(
			'https://facet.example/.well-known/security.txt',
			{},
			env,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/plain');
		const body = await res.text();
		const f = fields(body);
		expect(f.Contact).toBeDefined();
		expect(f.Canonical).toBe('https://facet.example/.well-known/security.txt');
		expect(Date.parse(f.Expires ?? '')).toBeGreaterThan(Date.now());
	});
});
