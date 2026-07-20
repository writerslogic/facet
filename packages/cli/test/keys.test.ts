// `facet keys generate`: generate a deployment signing keypair. Verifies stdout emits a valid private
// JWK (the FACET_SIGNING_JWK secret), that it round-trips through @facet/trust's loader, and that the
// alg flag is honored/validated.

import { loadSigningKey } from '@facet/trust';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

describe('facet keys generate', () => {
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

	it('prints a loadable Ed25519 private JWK by default (exit 0)', async () => {
		const code = await main(['keys', 'generate']);
		expect(code).toBe(0);
		const jwk = JSON.parse(stdout.trim());
		expect(jwk.kty).toBe('OKP');
		expect(jwk.crv).toBe('Ed25519');
		expect(jwk.d).toBeTruthy();
		const key = await loadSigningKey(stdout.trim());
		expect(key.alg).toBe('EdDSA');
		expect(key.kid).toBe(jwk.kid);
	});

	it('honors --alg ES256 (exit 0)', async () => {
		const code = await main(['keys', 'generate', '--alg', 'ES256']);
		expect(code).toBe(0);
		const key = await loadSigningKey(stdout.trim());
		expect(key.alg).toBe('ES256');
	});

	it('rejects an unsupported --alg (exit 1)', async () => {
		const code = await main(['keys', 'generate', '--alg', 'RS256']);
		expect(code).toBe(1);
		expect(stderr).toContain('EdDSA or ES256');
	});
});
