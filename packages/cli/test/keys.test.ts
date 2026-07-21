// `facet keys generate`: generate a deployment signing keypair. Verifies stdout emits a valid private
// JWK (the FACET_SIGNING_JWK secret), that it round-trips through @facet/trust's loader, and that the
// alg flag is honored/validated.

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

	it('writes --out with 0600 even when the target file already exists world-readable', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'facet-keys-'));
		const out = join(dir, 'signing.jwk');
		try {
			// Pre-create world-readable; a plain writeFile(mode) would not chmod an existing inode.
			await writeFile(out, 'placeholder', { mode: 0o644 });
			const code = await main(['keys', 'generate', '--out', out]);
			expect(code).toBe(0);
			expect((await stat(out)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('exits 1 with a clean message (no stack trace) on an unknown flag', async () => {
		const code = await main(['keys', 'generate', '--bogus']);
		expect(code).toBe(1);
		expect(stderr).not.toContain('at ');
		expect(stderr.trim().length).toBeGreaterThan(0);
	});
});
