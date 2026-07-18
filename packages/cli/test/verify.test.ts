// `facet verify export <file>`: a valid signed-export envelope verifies (exit 0), a tampered payload
// fails (exit 1), and usage/argument errors behave. The envelope is produced with @facet/trust, the
// same primitives the server signs with, so this is a real end-to-end offline verification.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildDidConfiguration,
	buildDidDocument,
	didWebFromHost,
	generateSigningJwk,
	issueDomainLinkageCredential,
	jwkToPublicKeyMultibase,
	loadSigningKey,
	signExport,
	signProcessEvidence,
} from '@facet/trust';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

const PAYLOAD = { columns: ['a', 'b'], rows: [['x', 1]] };

async function tmpFile(name: string, contents: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'facet-verify-'));
	const file = join(dir, name);
	await writeFile(file, JSON.stringify(contents));
	return file;
}

async function writeEnvelope(tamper: boolean): Promise<string> {
	const { privateJwk } = await generateSigningJwk('EdDSA');
	const key = await loadSigningKey(JSON.stringify(privateJwk));
	const env = await signExport(PAYLOAD, key, { now: Date.UTC(2026, 6, 1) });
	if (tamper) env.payload = { columns: ['a', 'b'], rows: [['x', 9999]] };
	return tmpFile('export.json', env);
}

describe('facet verify export', () => {
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

	it('verifies a valid signed export (exit 0)', async () => {
		const file = await writeEnvelope(false);
		const code = await main(['verify', 'export', file]);
		expect(code).toBe(0);
		expect(stdout).toContain('valid');
	});

	it('rejects a tampered signed export (exit 1)', async () => {
		const file = await writeEnvelope(true);
		const code = await main(['verify', 'export', file]);
		expect(code).toBe(1);
		expect(stderr).toContain('invalid');
	});

	it('errors on a missing file argument', async () => {
		const code = await main(['verify', 'export']);
		expect(code).toBe(1);
		expect(stderr).toContain('missing');
	});

	it('errors on an unknown verify target', async () => {
		const code = await main(['verify', 'bogus', 'x']);
		expect(code).toBe(1);
		expect(stderr).toContain('unknown verify target');
	});

	it('verifies a credential with --key (multibase)', async () => {
		const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
		const key = await loadSigningKey(JSON.stringify(privateJwk));
		const did = didWebFromHost('facet.example');
		const cred = await issueDomainLinkageCredential({
			did,
			origin: 'https://facet.example',
			key,
			created: '2026-07-01T00:00:00.000Z',
		});
		const file = await tmpFile('cred.json', cred);
		const code = await main([
			'verify',
			'credential',
			file,
			'--key',
			jwkToPublicKeyMultibase(publicJwk),
		]);
		expect(code).toBe(0);
		expect(stdout).toContain('valid credential');
	});

	it('verifies a did-configuration against a DID document', async () => {
		const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
		const key = await loadSigningKey(JSON.stringify(privateJwk));
		const did = didWebFromHost('facet.example');
		const didDoc = buildDidDocument(did, key.kid, publicJwk);
		const cred = await issueDomainLinkageCredential({
			did,
			origin: 'https://facet.example',
			key,
			created: '2026-07-01T00:00:00.000Z',
		});
		const cfgFile = await tmpFile('config.json', buildDidConfiguration([cred]));
		const docFile = await tmpFile('did.json', didDoc);
		const code = await main(['verify', 'did-configuration', cfgFile, '--did-doc', docFile]);
		expect(code).toBe(0);
		expect(stdout).toContain('valid domain linkage');
	});

	it('verifies a RATS process-evidence attestation', async () => {
		const { privateJwk } = await generateSigningJwk('EdDSA');
		const key = await loadSigningKey(JSON.stringify(privateJwk));
		const eat = await signProcessEvidence(
			{
				buildId: 'ci-1',
				commit: 'abc',
				schemaHash: 'f'.repeat(64),
				wranglerHash: 'a'.repeat(64),
				privacyTransforms: ['cookieless'],
			},
			key,
			{ now: 1_770_000_000_000, nonce: 'n1' },
		);
		const file = await tmpFile('eat.json', eat);
		expect(await main(['verify', 'attestation', file, '--nonce', 'n1'])).toBe(0);
		expect(stdout).toContain('valid RATS process evidence');
		// Wrong nonce fails.
		expect(await main(['verify', 'attestation', file, '--nonce', 'bad'])).toBe(1);
	});
});
