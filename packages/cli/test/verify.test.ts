// `facet verify export <file>`: a valid signed-export envelope verifies (exit 0), a tampered payload
// fails (exit 1), and usage/argument errors behave. The envelope is produced with @facet/trust, the
// same primitives the server signs with, so this is a real end-to-end offline verification.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningJwk, loadSigningKey, signExport } from '@facet/trust';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

const PAYLOAD = { columns: ['a', 'b'], rows: [['x', 1]] };

async function writeEnvelope(tamper: boolean): Promise<string> {
	const { privateJwk } = await generateSigningJwk('EdDSA');
	const key = await loadSigningKey(JSON.stringify(privateJwk));
	const env = await signExport(PAYLOAD, key, { now: Date.UTC(2026, 6, 1) });
	if (tamper) env.payload = { columns: ['a', 'b'], rows: [['x', 9999]] };
	const dir = await mkdtemp(join(tmpdir(), 'facet-verify-'));
	const file = join(dir, 'export.json');
	await writeFile(file, JSON.stringify(env));
	return file;
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
});
