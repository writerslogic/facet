// `normalizeHost` is the one boundary where an operator-supplied origin becomes the destination for a
// bearer credential, so these pin the rejections rather than the happy path.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageError, normalizeHost, resolveHost } from '../src/admin.js';

describe('normalizeHost', () => {
	it('reduces a valid https URL to a bare origin', () => {
		expect(normalizeHost('https://a.example.com')).toBe('https://a.example.com');
		expect(normalizeHost('https://a.example.com/')).toBe('https://a.example.com');
		expect(normalizeHost('https://a.example.com:8443')).toBe('https://a.example.com:8443');
	});

	it('allows http only for loopback, where `wrangler dev` serves', () => {
		expect(normalizeHost('http://localhost:8787')).toBe('http://localhost:8787');
		expect(normalizeHost('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
		expect(normalizeHost('http://[::1]:8787')).toBe('http://[::1]:8787');
	});

	it('refuses plain http to a remote host so the token is never sent in the clear', () => {
		expect(() => normalizeHost('http://a.example.com')).toThrow(UsageError);
		expect(() => normalizeHost('http://a.example.com')).toThrow(/unencrypted/);
	});

	it('rejects a non-http scheme', () => {
		expect(() => normalizeHost('ftp://a.example.com')).toThrow(UsageError);
		expect(() => normalizeHost('file:///etc/passwd')).toThrow(UsageError);
	});

	it('rejects credentials embedded in the URL', () => {
		expect(() => normalizeHost('https://user:pw@a.example.com')).toThrow(/credentials/);
	});

	it('rejects a host carrying a path, query or fragment', () => {
		expect(() => normalizeHost('https://a.example.com/api')).toThrow(/only the origin/);
		expect(() => normalizeHost('https://a.example.com/?x=1')).toThrow(/only the origin/);
		expect(() => normalizeHost('https://a.example.com/#f')).toThrow(/only the origin/);
	});

	it('rejects a value that is not an absolute URL', () => {
		expect(() => normalizeHost('a.example.com')).toThrow(/absolute URL/);
		expect(() => normalizeHost('')).toThrow(/absolute URL/);
	});
});

describe('resolveHost', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('prefers the flag over FACET_HOST', () => {
		vi.stubEnv('FACET_HOST', 'https://env.example.com');
		expect(resolveHost('https://flag.example.com')).toBe('https://flag.example.com');
	});

	it('falls back to FACET_HOST', () => {
		vi.stubEnv('FACET_HOST', 'https://env.example.com/');
		expect(resolveHost(undefined)).toBe('https://env.example.com');
	});

	it('validates the env value, not just the flag', () => {
		vi.stubEnv('FACET_HOST', 'http://env.example.com');
		expect(() => resolveHost(undefined)).toThrow(/unencrypted/);
	});

	it('reports a missing host distinctly from an invalid one', () => {
		vi.stubEnv('FACET_HOST', '');
		expect(() => resolveHost(undefined)).toThrow(/Missing deployment host/);
	});
});
