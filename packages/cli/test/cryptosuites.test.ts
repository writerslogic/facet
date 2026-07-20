// Standards-conformant W3C selective-disclosure cryptosuites (Node-only): for BOTH ecdsa-sd-2023 and
// bbs-2023, a real issue → deriveProof (selective reveal) → verify, plus tamper → fail. These run the
// digitalbazaar reference suites with a static, no-network document loader. Node runtime (the CLI's).

import { describe, expect, it } from 'vitest';
import {
	type SdSuite,
	deriveSelective,
	generateIssuerKey,
	issueSelective,
	verifySelective,
} from '../src/lib/cryptosuites.js';

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
	} as Record<string, unknown>;
}

for (const suite of ['ecdsa-sd-2023', 'bbs-2023'] as SdSuite[]) {
	describe(`${suite}`, () => {
		it('issues, selectively discloses, and verifies', async () => {
			const key = await generateIssuerKey(suite);
			const signed = await issueSelective(suite, credential(), key, ['/issuer']);
			expect((signed.proof as { cryptosuite: string }).cryptosuite).toBe(suite);

			const derived = await deriveSelective(suite, signed, key, [
				'/credentialSubject/exName',
			]);
			const subject = derived.credentialSubject as Record<string, unknown>;
			expect(subject.exName).toBe('Facet');
			// Undisclosed claims are cryptographically removed from the presentation.
			expect(subject.exRole).toBeUndefined();
			expect(subject.exTeam).toBeUndefined();

			const result = await verifySelective(suite, derived, key);
			expect(result.verified).toBe(true);
		});

		it('fails verification when a disclosed claim is tampered', async () => {
			const key = await generateIssuerKey(suite);
			const signed = await issueSelective(suite, credential(), key, ['/issuer']);
			const derived = await deriveSelective(suite, signed, key, [
				'/credentialSubject/exName',
			]);
			(derived.credentialSubject as Record<string, unknown>).exName = 'Forged';
			const result = await verifySelective(suite, derived, key);
			expect(result.verified).toBe(false);
		});

		it('fails verification under a different issuer key', async () => {
			const key = await generateIssuerKey(suite);
			const other = await generateIssuerKey(suite);
			const signed = await issueSelective(suite, credential(), key, ['/issuer']);
			const derived = await deriveSelective(suite, signed, key, [
				'/credentialSubject/exName',
			]);
			const result = await verifySelective(suite, derived, other);
			expect(result.verified).toBe(false);
		});
	});
}
