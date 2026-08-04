// `facet keys generate`: generate a deployment signing keypair. Verifies stdout emits a valid private
// JWK (the FACET_SIGNING_JWK secret), that it round-trips through @facet/trust's loader, and that the
// alg flag is honored/validated.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSigningKey } from '@facet/trust';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

// Records the order of calls made against the FileHandle `keys generate --out` opens, so the tests
// below can assert WHEN the mode was tightened rather than only what it ended up as.
vi.mock('node:fs/promises', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...real,
		default: real,
		open: async (...args: Parameters<typeof real.open>) => {
			const handle = await real.open(...args);
			return new Proxy(handle, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== 'function') return value;
					return (...callArgs: unknown[]) => {
						calls.push(String(prop));
						return (value as (...a: unknown[]) => unknown).apply(target, callArgs);
					};
				},
			});
		},
	};
});

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
			await expect(loadSigningKey(await readFile(out, 'utf8'))).resolves.toBeTruthy();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('tightens --out before the private key is written, not after', async () => {
		// The ordering is the guarantee. A chmod that runs after the write leaves the private signing
		// key readable by every local account for the window between the two syscalls, and `stat`
		// afterwards cannot tell the two orderings apart.
		const dir = await mkdtemp(join(tmpdir(), 'facet-keys-'));
		const out = join(dir, 'signing.jwk');
		try {
			await writeFile(out, 'placeholder', { mode: 0o644 });
			calls.length = 0;

			expect(await main(['keys', 'generate', '--out', out])).toBe(0);

			expect(calls.indexOf('chmod')).toBeGreaterThanOrEqual(0);
			expect(calls.indexOf('chmod')).toBeLessThan(calls.indexOf('writeFile'));
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
