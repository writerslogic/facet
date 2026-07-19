// VC Data Integrity (eddsa-jcs-2022) + Multikey + base58 + did:web / DID Configuration. Runs in
// workerd. Covers: base58 round-trip, JWK<->publicKeyMultibase, credential issue/verify, tamper and
// wrong-key failure, did:web URL resolution, and a full domain-linkage verification against a DID doc.

import { describe, expect, it } from 'vitest';
import { base58decode, base58encode } from '../src/base58.js';
import {
	buildDidConfiguration,
	buildDidDocument,
	didWebFromHost,
	didWebToUrl,
	issueDomainLinkageCredential,
	verifyDidConfiguration,
} from '../src/did-web.js';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';
import { jwkToPublicKeyMultibase, publicKeyMultibaseToJwk } from '../src/multikey.js';
import {
	VC_V2_CONTEXT,
	type VerifiableCredential,
	issueCredential,
	verifyCredential,
} from '../src/vc.js';

async function edKey() {
	const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
	return { key: await loadSigningKey(JSON.stringify(privateJwk)), publicJwk };
}

describe('base58', () => {
	it('round-trips arbitrary bytes and preserves leading zeros', () => {
		for (const bytes of [
			new Uint8Array([0, 0, 1, 2, 3]),
			new Uint8Array([255, 254, 0, 42]),
			new Uint8Array(32).fill(7),
		]) {
			expect(Array.from(base58decode(base58encode(bytes)))).toEqual(Array.from(bytes));
		}
	});
});

describe('multikey', () => {
	it('encodes an Ed25519 JWK to publicKeyMultibase (z6Mk…) and back', async () => {
		const { publicJwk } = await generateSigningJwk('EdDSA');
		const mb = jwkToPublicKeyMultibase(publicJwk);
		expect(mb.startsWith('z6Mk')).toBe(true);
		const back = publicKeyMultibaseToJwk(mb);
		expect(back.x).toBe(publicJwk.x);
	});
});

describe('eddsa-jcs-2022 credential', () => {
	const base: VerifiableCredential = {
		'@context': [VC_V2_CONTEXT],
		type: ['VerifiableCredential', 'PrivacyAttestationCredential'],
		issuer: 'did:web:facet.example',
		validFrom: '2026-07-01T00:00:00.000Z',
		credentialSubject: { id: 'did:web:facet.example', retentionDays: 90 },
	};

	it('issues and verifies with the embedded key (JWK or multibase)', async () => {
		const { key, publicJwk } = await edKey();
		const vc = await issueCredential(base, key, {
			verificationMethod: `did:web:facet.example#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		expect(vc.proof?.cryptosuite).toBe('eddsa-jcs-2022');
		expect(vc.proof?.proofValue.startsWith('z')).toBe(true);

		expect((await verifyCredential(vc, { publicJwk })).valid).toBe(true);
		const mb = jwkToPublicKeyMultibase(publicJwk);
		expect((await verifyCredential(vc, { publicKeyMultibase: mb })).valid).toBe(true);
	});

	it('fails when a claim is tampered', async () => {
		const { key, publicJwk } = await edKey();
		const vc = await issueCredential(base, key, {
			verificationMethod: `did:web:facet.example#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		vc.credentialSubject.retentionDays = 3650;
		const res = await verifyCredential(vc, { publicJwk });
		expect(res.valid).toBe(false);
	});

	it('fails under a different key', async () => {
		const { key } = await edKey();
		const other = await generateSigningJwk('EdDSA');
		const vc = await issueCredential(base, key, {
			verificationMethod: `did:web:facet.example#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		expect((await verifyCredential(vc, { publicJwk: other.publicJwk })).valid).toBe(false);
	});

	it('refuses to issue with a non-Ed25519 key', async () => {
		const { privateJwk } = await generateSigningJwk('ES256');
		const es = await loadSigningKey(JSON.stringify(privateJwk));
		await expect(
			issueCredential(base, es, {
				verificationMethod: 'x#y',
				created: 'now',
			}),
		).rejects.toThrow();
	});
});

describe('did:web', () => {
	it('builds the DID and resolves its document URL', () => {
		expect(didWebFromHost('facet.example')).toBe('did:web:facet.example');
		expect(didWebToUrl('did:web:facet.example')).toBe(
			'https://facet.example/.well-known/did.json',
		);
		expect(didWebToUrl('did:web:facet.example:tenant:a')).toBe(
			'https://facet.example/tenant/a/did.json',
		);
	});

	it('verifies a full domain linkage against the DID document', async () => {
		const { key, publicJwk } = await edKey();
		const did = didWebFromHost('facet.example');
		const origin = 'https://facet.example';
		const didDoc = buildDidDocument(did, key.kid, publicJwk);
		const cred = await issueDomainLinkageCredential({
			did,
			origin,
			key,
			created: '2026-07-01T00:00:00.000Z',
		});
		const config = buildDidConfiguration([cred]);

		const ok = await verifyDidConfiguration(config, didDoc, origin);
		expect(ok.valid).toBe(true);
		expect(ok.origin).toBe(origin);

		// Wrong origin must fail.
		const bad = await verifyDidConfiguration(config, didDoc, 'https://evil.example');
		expect(bad.valid).toBe(false);
	});
});
