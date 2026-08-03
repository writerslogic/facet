// RFC 9116 security.txt: served from the Worker at /.well-known/security.txt with the correct
// content type, a future Expires, and Canonical bound to the request origin. The builder is also
// unit-tested for the required fields and future-expiry invariant.
//
// The load-bearing case is the UNCONFIGURED one. A security.txt is a claim by the operator of the
// host it is served from, so a shipped default contact would make every self-hoster who never set
// `FACET_SECURITY_CONTACT` publish the upstream maintainer's mailbox as their own disclosure
// address. These tests pin that no such default exists: unconfigured means no document at all.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
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

function req(overrides?: Partial<Env>) {
	return createApp().request('https://facet.example/.well-known/security.txt', {}, {
		...env,
		...overrides,
	} as Env);
}

describe('buildSecurityTxt', () => {
	it('includes required fields with a future Expires', () => {
		const now = Date.UTC(2026, 0, 1);
		const body = buildSecurityTxt({
			origin: 'https://a.example.com',
			contact: 'mailto:sec@op.example',
			now,
		});
		const f = fields(body);
		expect(f.Contact).toBe('mailto:sec@op.example');
		expect(f.Canonical).toBe('https://a.example.com/.well-known/security.txt');
		expect(Date.parse(f.Expires ?? '')).toBeGreaterThan(now);
	});

	it('omits Policy unless the operator supplied one', () => {
		const now = Date.UTC(2026, 0, 1);
		const without = buildSecurityTxt({
			origin: 'https://a.example.com',
			contact: 'mailto:sec@op.example',
			now,
		});
		expect(fields(without).Policy).toBeUndefined();

		const withPolicy = buildSecurityTxt({
			origin: 'https://a.example.com',
			contact: 'mailto:sec@op.example',
			policy: 'https://op.example/policy',
			now,
		});
		expect(fields(withPolicy).Policy).toBe('https://op.example/policy');
	});
});

describe('GET /.well-known/security.txt', () => {
	it('serves a valid, unexpired security.txt as text/plain when a contact is configured', async () => {
		const res = await req({ FACET_SECURITY_CONTACT: 'mailto:sec@op.example' });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/plain');
		const body = await res.text();
		const f = fields(body);
		expect(f.Contact).toBe('mailto:sec@op.example');
		expect(f.Canonical).toBe('https://facet.example/.well-known/security.txt');
		expect(Date.parse(f.Expires ?? '')).toBeGreaterThan(Date.now());
	});

	it('publishes NO security.txt — and no third-party contact — when unconfigured', async () => {
		// The default test env sets no FACET_SECURITY_CONTACT, i.e. exactly what a fresh self-hoster
		// gets. This must not fall back to any address the operator did not choose.
		expect(env.FACET_SECURITY_CONTACT).toBeUndefined();
		const res = await req();
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).not.toMatch(/@/); // no mailbox of any kind, from anyone
		expect(body.toLowerCase()).not.toContain('writerslogic');
		expect(body.toLowerCase()).not.toContain('contact:');
	});

	it('ignores a blank contact rather than serving a Contact-less (invalid) file', async () => {
		const res = await req({ FACET_SECURITY_CONTACT: '   ' });
		expect(res.status).toBe(404);
	});

	it('serves no Policy when only a contact is configured', async () => {
		const res = await req({ FACET_SECURITY_CONTACT: 'mailto:sec@op.example' });
		const body = await res.text();
		expect(fields(body).Policy).toBeUndefined();
		expect(body).not.toContain('SECURITY.md');
	});
});
