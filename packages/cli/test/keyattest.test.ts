// `facet keyattest verify`: verify a real X.509 hardware key-attestation chain against a configured
// root, and confirm the leaf certifies the deployment signing key (SPKI match). Uses STATIC committed
// PEM fixtures (generated once offline with openssl — see test/fixtures/keyattest/), no runtime cert
// minting. Valid chain + SPKI match → exit 0; wrong root, leaf issued by another CA, and a
// deployment-key SPKI mismatch each → exit 1.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'keyattest');
const fx = (name: string) => join(FIXTURES, name);

describe('facet keyattest verify', () => {
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

	it('verifies a valid chain whose leaf certifies the deployment key (exit 0)', async () => {
		const code = await main([
			'keyattest',
			'verify',
			fx('leaf.pem'),
			'--root',
			fx('root.pem'),
			'--key',
			fx('leaf.pub.pem'),
		]);
		expect(code).toBe(0);
		expect(stdout).toContain('hardware key-attestation verified');
	});

	it('accepts the deployment key given as the leaf certificate itself (SPKI extracted)', async () => {
		const code = await main([
			'keyattest',
			'verify',
			fx('leaf.pem'),
			'--root',
			fx('root.pem'),
			'--key',
			fx('leaf.pem'),
		]);
		expect(code).toBe(0);
	});

	it('rejects a chain against the WRONG root (exit 1)', async () => {
		const code = await main([
			'keyattest',
			'verify',
			fx('leaf.pem'),
			'--root',
			fx('wrong-root.pem'),
			'--key',
			fx('leaf.pub.pem'),
		]);
		expect(code).toBe(1);
		expect(stderr).toContain('chain does not verify');
	});

	it('rejects a leaf issued by a different CA than the configured root (exit 1)', async () => {
		const code = await main([
			'keyattest',
			'verify',
			fx('leaf-wrong-issuer.pem'),
			'--root',
			fx('root.pem'),
			'--key',
			fx('leaf.pub.pem'),
		]);
		expect(code).toBe(1);
		expect(stderr).toContain('chain does not verify');
	});

	it('rejects when the leaf does not certify the deployment key (SPKI mismatch, exit 1)', async () => {
		const code = await main([
			'keyattest',
			'verify',
			fx('leaf.pem'),
			'--root',
			fx('root.pem'),
			'--key',
			fx('other-deploy.pub.pem'),
		]);
		expect(code).toBe(1);
		expect(stderr).toContain('SPKI mismatch');
	});

	it('rejects when the chain is not valid at --now (exit 1)', async () => {
		const code = await main([
			'keyattest',
			'verify',
			fx('leaf.pem'),
			'--root',
			fx('root.pem'),
			'--key',
			fx('leaf.pub.pem'),
			'--now',
			'2099-01-01T00:00:00.000Z',
		]);
		expect(code).toBe(1);
		expect(stderr).toContain('not valid at');
	});

	it('errors on missing --root', async () => {
		const code = await main([
			'keyattest',
			'verify',
			fx('leaf.pem'),
			'--key',
			fx('leaf.pub.pem'),
		]);
		expect(code).toBe(1);
		expect(stderr).toContain('trust anchor');
	});

	it('errors on an unknown keyattest op', async () => {
		const code = await main(['keyattest', 'bogus']);
		expect(code).toBe(1);
		expect(stderr).toContain('unknown keyattest op');
	});
});
