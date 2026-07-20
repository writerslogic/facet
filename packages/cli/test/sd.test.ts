// `facet sd`: full keygen → issue → derive (selective reveal) → verify through the CLI entrypoint, for
// both W3C cryptosuites, plus verify exit code 1 on a tampered presentation. Node-only.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

const VC_V2 = 'https://www.w3.org/ns/credentials/v2';

function credential() {
	return {
		'@context': [
			VC_V2,
			{
				'@version': 1.1,
				'@protected': true,
				ex: 'https://example.org/#',
				exName: 'ex:name',
				exRole: 'ex:role',
				exTeam: 'ex:team',
			},
		],
		type: ['VerifiableCredential'],
		issuer: 'did:key:facet-issuer',
		validFrom: '2026-01-01T00:00:00Z',
		credentialSubject: {
			id: 'did:example:subject',
			exName: 'Facet',
			exRole: 'issuer',
			exTeam: 'trust',
		},
	};
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'facet-sd-'));
	vi.spyOn(process.stdout, 'write').mockReturnValue(true);
	vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

for (const suite of ['ecdsa-sd-2023', 'bbs-2023'] as const) {
	describe(`facet sd (${suite})`, () => {
		it('keygen → issue → derive → verify round-trips (exit 0)', async () => {
			const keyFile = join(dir, 'key.json');
			const credFile = join(dir, 'cred.json');
			const signedFile = join(dir, 'signed.json');
			const presFile = join(dir, 'pres.json');
			await writeFile(credFile, JSON.stringify(credential()));

			expect(await main(['sd', 'keygen', '--suite', suite, '--out', keyFile])).toBe(0);
			expect(
				await main([
					'sd',
					'issue',
					'--suite',
					suite,
					'--credential',
					credFile,
					'--key',
					keyFile,
					'--mandatory',
					'/issuer',
					'--out',
					signedFile,
				]),
			).toBe(0);
			expect(
				await main([
					'sd',
					'derive',
					'--suite',
					suite,
					'--credential',
					signedFile,
					'--key',
					keyFile,
					'--reveal',
					'/credentialSubject/exName',
					'--out',
					presFile,
				]),
			).toBe(0);

			const pres = JSON.parse(await readFile(presFile, 'utf8')) as {
				credentialSubject: Record<string, unknown>;
			};
			expect(pres.credentialSubject.exName).toBe('Facet');
			expect(pres.credentialSubject.exRole).toBeUndefined();

			expect(
				await main([
					'sd',
					'verify',
					'--suite',
					suite,
					'--presentation',
					presFile,
					'--key',
					keyFile,
				]),
			).toBe(0);
		});

		it('verify exits 1 on a tampered presentation', async () => {
			const keyFile = join(dir, 'key.json');
			const credFile = join(dir, 'cred.json');
			const signedFile = join(dir, 'signed.json');
			const presFile = join(dir, 'pres.json');
			await writeFile(credFile, JSON.stringify(credential()));
			await main(['sd', 'keygen', '--suite', suite, '--out', keyFile]);
			await main([
				'sd',
				'issue',
				'--suite',
				suite,
				'--credential',
				credFile,
				'--key',
				keyFile,
				'--out',
				signedFile,
			]);
			await main([
				'sd',
				'derive',
				'--suite',
				suite,
				'--credential',
				signedFile,
				'--key',
				keyFile,
				'--reveal',
				'/credentialSubject/exName',
				'--out',
				presFile,
			]);
			const pres = JSON.parse(await readFile(presFile, 'utf8')) as {
				credentialSubject: Record<string, unknown>;
			};
			pres.credentialSubject.exName = 'Forged';
			await writeFile(presFile, JSON.stringify(pres));

			expect(
				await main([
					'sd',
					'verify',
					'--suite',
					suite,
					'--presentation',
					presFile,
					'--key',
					keyFile,
				]),
			).toBe(1);
		});
	});
}
