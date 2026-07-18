// P3.6: the two credential types + Workers-native selective disclosure. Credentials issue/verify with
// eddsa-jcs-2022; SD reveals a subset of claims, hides the rest as digests, and fails on tamper.

import { describe, expect, it } from 'vitest';
import {
	buildAnalyticsReportCredential,
	buildPrivacyAttestationCredential,
} from '../src/credentials.js';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';
import {
	deriveDisclosure,
	issueSelectiveCredential,
	verifySelectiveCredential,
} from '../src/sd.js';
import { VC_V2_CONTEXT, issueCredential, verifyCredential } from '../src/vc.js';

const DID = 'did:web:facet.example';

async function edKey() {
	const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
	return { key: await loadSigningKey(JSON.stringify(privateJwk)), publicJwk };
}

describe('credential types', () => {
	it('issues and verifies a PrivacyAttestationCredential', async () => {
		const { key, publicJwk } = await edKey();
		const doc = buildPrivacyAttestationCredential({
			did: DID,
			created: '2026-07-01T00:00:00.000Z',
			deployment: {
				buildId: 'ci-42',
				commit: 'abc123',
				schemaHash: 'deadbeef',
				retentionDays: 90,
				privacy: {
					visitorHash: 'daily-rotating-salted-sha256',
					hashesIp: true,
					storesRawIp: false,
					cookies: false,
				},
			},
		});
		const vc = await issueCredential(doc, key, {
			verificationMethod: `${DID}#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		expect(vc.type).toContain('PrivacyAttestationCredential');
		expect((await verifyCredential(vc, { publicJwk })).valid).toBe(true);
	});

	it('issues and verifies an AnalyticsReportCredential', async () => {
		const { key, publicJwk } = await edKey();
		const doc = buildAnalyticsReportCredential({
			did: DID,
			created: '2026-07-01T00:00:00.000Z',
			site: '11111111-1111-4111-8111-111111111111',
			subjectId: 'https://facet.example/sites/11111111-1111-4111-8111-111111111111',
			range: { start: 1_700_000_000_000, end: 1_700_600_000_000 },
			report: { pageviews: 1240, visitors: 830, events: 44 },
		});
		const vc = await issueCredential(doc, key, {
			verificationMethod: `${DID}#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		expect(vc.type).toContain('AnalyticsReportCredential');
		const res = await verifyCredential(vc, { publicJwk });
		expect(res.valid).toBe(true);
	});
});

describe('selective disclosure (SD-JWT-style, Workers-native)', () => {
	const base = {
		'@context': [VC_V2_CONTEXT],
		type: ['VerifiableCredential', 'AnalyticsReportCredential'],
		issuer: DID,
		validFrom: '2026-07-01T00:00:00.000Z',
		credentialSubject: { id: 'https://facet.example/sites/s1' },
	};

	it('reveals a subset, hides the rest, and verifies', async () => {
		const { key, publicJwk } = await edKey();
		const issued = await issueSelectiveCredential(
			base,
			{ site: 's1' },
			{ pageviews: 1240, visitors: 830, events: 44 },
			key,
			{
				verificationMethod: `${DID}#${key.kid}`,
				created: '2026-07-01T00:00:00.000Z',
			},
		);
		// The signed credential carries only digests for selective claims, not their values.
		// biome-ignore lint/style/useNamingConvention: `_sd` is the SD-JWT spec-defined digest array name.
		const sd = (issued.credential.credentialSubject as { _sd: string[] })._sd;
		expect(sd).toHaveLength(3);
		expect(JSON.stringify(issued.credential.credentialSubject)).not.toContain('1240');

		// Reveal only visitors.
		const presentation = deriveDisclosure(issued, ['visitors']);
		expect(presentation.disclosures).toHaveLength(1);
		const res = await verifySelectiveCredential(presentation, {
			publicJwk,
		});
		expect(res.valid).toBe(true);
		expect(res.revealed).toEqual({ visitors: 830 });
	});

	it('fails when a disclosed value is tampered', async () => {
		const { key, publicJwk } = await edKey();
		const issued = await issueSelectiveCredential(base, {}, { pageviews: 1240 }, key, {
			verificationMethod: `${DID}#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		const presentation = deriveDisclosure(issued, ['pageviews']);
		if (presentation.disclosures[0]) presentation.disclosures[0].value = 999999;
		const res = await verifySelectiveCredential(presentation, {
			publicJwk,
		});
		expect(res.valid).toBe(false);
	});

	it('fails when the credential proof is tampered', async () => {
		const { key, publicJwk } = await edKey();
		const issued = await issueSelectiveCredential(base, {}, { pageviews: 1240 }, key, {
			verificationMethod: `${DID}#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		(issued.credential.credentialSubject as { site?: string }).site = 'injected';
		const res = await verifySelectiveCredential(deriveDisclosure(issued, ['pageviews']), {
			publicJwk,
		});
		expect(res.valid).toBe(false);
	});
});
