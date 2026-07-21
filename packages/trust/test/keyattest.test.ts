// Hardware key-attestation, workerd-verified. A mock attestor signs an attestation for a subject key;
// verification yields hardware:true ONLY against the attestor's trust anchor. Wrong anchor, absent
// anchor, thumbprint mismatch, and tamper all force hardware:false. The RATS wiring is exercised too:
// an EAT issued with a verified attestation → AttestationResult.hardwareRootOfTrust true; without → false.
// The central security assertion: hardware:true / hardwareRootOfTrust:true are UNREACHABLE without a
// trust-anchor-verified attestation.

import { calculateJwkThumbprint } from 'jose';
import { describe, expect, it } from 'vitest';
import {
	KEY_ATTESTATION_TYPE,
	signKeyAttestation,
	verifyKeyAttestation,
} from '../src/keyattest.js';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';
import {
	type ProcessEvidence,
	answerPopChallenge,
	signProcessEvidence,
	verifyPopChallenge,
	verifyProcessEvidence,
} from '../src/rats.js';
import { signStatement } from '../src/statement.js';

const NOW = 1_770_000_000_000;

const EVIDENCE: ProcessEvidence = {
	buildId: 'ci-hw',
	commit: 'deadbee',
	schemaHash: 'f'.repeat(64),
	wranglerHash: 'a'.repeat(64),
	privacyTransforms: ['cookieless'],
};

async function edKey() {
	const { privateJwk } = await generateSigningJwk('EdDSA');
	return loadSigningKey(JSON.stringify(privateJwk));
}

const DEVICE = {
	deviceClass: 'hsm' as const,
	fipsLevel: 3,
	vendor: 'ACME KMS-HSM',
};

describe('key-attestation verification (workerd)', () => {
	it('yields hardware:true only against the attestor trust anchor', async () => {
		const attestor = await edKey();
		const subject = await edKey();
		const att = await signKeyAttestation(subject.publicJwk, DEVICE, attestor, NOW);

		const good = await verifyKeyAttestation(att, {
			trustAnchors: [attestor.publicJwk],
			now: NOW,
			expectedThumbprint: await calculateJwkThumbprint(subject.publicJwk),
		});
		expect(good.valid).toBe(true);
		expect(good.hardware).toBe(true);
		expect(good.deviceClass).toBe('hsm');
		expect(good.fipsLevel).toBe(3);
		expect(good.vendor).toBe('ACME KMS-HSM');
	});

	it('never embeds private key material even if a PRIVATE JWK is passed as the subject', async () => {
		const attestor = await edKey();
		const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
		expect(privateJwk.d).toBeTruthy();
		// A caller mistake: pass the PRIVATE jwk. The attestation must strip `d`, not publish it.
		const att = await signKeyAttestation(privateJwk, DEVICE, attestor, NOW);
		expect((att.payload.subjectPublicJwk as { d?: string }).d).toBeUndefined();
		const res = await verifyKeyAttestation(att, {
			trustAnchors: [attestor.publicJwk],
			now: NOW,
			expectedThumbprint: await calculateJwkThumbprint(publicJwk),
		});
		expect(res.hardware).toBe(true);
	});

	it('yields hardware:false with a WRONG trust anchor (signature valid, not anchored)', async () => {
		const attestor = await edKey();
		const wrongAnchor = await edKey();
		const subject = await edKey();
		const att = await signKeyAttestation(subject.publicJwk, DEVICE, attestor, NOW);

		const res = await verifyKeyAttestation(att, {
			trustAnchors: [wrongAnchor.publicJwk],
			now: NOW,
		});
		expect(res.valid).toBe(true);
		expect(res.hardware).toBe(false);
		expect(res.reason).toMatch(/trust anchor/);
	});

	it('yields hardware:false with NO trust anchors', async () => {
		const attestor = await edKey();
		const subject = await edKey();
		const att = await signKeyAttestation(subject.publicJwk, DEVICE, attestor, NOW);

		const res = await verifyKeyAttestation(att, {
			trustAnchors: [],
			now: NOW,
		});
		expect(res.valid).toBe(true);
		expect(res.hardware).toBe(false);
	});

	it('fails when the expected thumbprint does not match the attested key', async () => {
		const attestor = await edKey();
		const subject = await edKey();
		const other = await edKey();
		const att = await signKeyAttestation(subject.publicJwk, DEVICE, attestor, NOW);

		const res = await verifyKeyAttestation(att, {
			trustAnchors: [attestor.publicJwk],
			now: NOW,
			expectedThumbprint: await calculateJwkThumbprint(other.publicJwk),
		});
		expect(res.hardware).toBe(false);
		expect(res.reason).toMatch(/expected key/);
	});

	it('fails when the attestation is tampered (subject key swapped in payload)', async () => {
		const attestor = await edKey();
		const subject = await edKey();
		const other = await edKey();
		const att = await signKeyAttestation(subject.publicJwk, DEVICE, attestor, NOW);
		// Swap the echoed subject JWK: the signature no longer covers this payload → verify fails.
		att.payload.subjectPublicJwk = other.publicJwk;

		const res = await verifyKeyAttestation(att, {
			trustAnchors: [attestor.publicJwk],
			now: NOW,
		});
		expect(res.valid).toBe(false);
		expect(res.hardware).toBe(false);
	});

	it('fails a self-consistency lie even when the signature covers the lying payload', async () => {
		const attestor = await edKey();
		const subject = await edKey();
		// Genuinely sign a payload whose declared thumbprint does NOT match the echoed subject key. The
		// signature is valid over this lying payload, so the only thing that catches it is the step-(2)
		// self-consistency check (recompute thumbprint of the echoed key, compare to the declared one).
		const template = await signKeyAttestation(subject.publicJwk, DEVICE, attestor, NOW);
		const lyingClaims = {
			...template.payload,
			subjectThumbprint: 'not-the-real-thumbprint',
		};
		const forged = await signStatement(KEY_ATTESTATION_TYPE, lyingClaims, attestor, NOW);
		const res = await verifyKeyAttestation(forged, {
			trustAnchors: [attestor.publicJwk],
			now: NOW,
		});
		// Signature verifies (valid), but the attestation lies about its subject key ⇒ not hardware.
		expect(res.valid).toBe(true);
		expect(res.hardware).toBe(false);
		expect(res.reason).toMatch(/thumbprint/);
	});

	it('hardware:true is UNREACHABLE without a trust-anchor-verified attestation', async () => {
		const attestor = await edKey();
		const subject = await edKey();
		const att = await signKeyAttestation(subject.publicJwk, DEVICE, attestor, NOW);
		// Every non-anchor configuration must yield hardware:false.
		for (const trustAnchors of [[], [subject.publicJwk], [(await edKey()).publicJwk]]) {
			const res = await verifyKeyAttestation(att, {
				trustAnchors,
				now: NOW,
			});
			expect(res.hardware).toBe(false);
		}
		// Only the real anchor flips it true.
		expect(
			(
				await verifyKeyAttestation(att, {
					trustAnchors: [attestor.publicJwk],
					now: NOW,
				})
			).hardware,
		).toBe(true);
	});
});

describe('RATS EAT hardware root of trust wiring (workerd)', () => {
	it('EAT with a verified attestation ⇒ hardware:true and hardwareRootOfTrust:true', async () => {
		const deploymentKey = await edKey(); // both EAT signer and cnf subject
		const attestor = await edKey();
		const att = await signKeyAttestation(deploymentKey.publicJwk, DEVICE, attestor, NOW);

		const eat = await signProcessEvidence(EVIDENCE, deploymentKey, {
			now: NOW,
			keyAttestation: att,
			keyAttestationAnchors: [attestor.publicJwk],
		});
		expect(eat.payload['key-attributes'].hardware).toBe(true);
		expect(eat.payload['key-attributes'].software).toBe(false);
		expect(eat.payload['key-attestation']?.deviceClass).toBe('hsm');

		const result = await verifyProcessEvidence(eat, {
			trustAnchors: [attestor.publicJwk],
		});
		expect(result.valid).toBe(true);
		expect(result.hardwareRootOfTrust).toBe(true);
	});

	it('EAT without an attestation ⇒ hardware:false, hardwareRootOfTrust:false (unchanged default)', async () => {
		const key = await edKey();
		const eat = await signProcessEvidence(EVIDENCE, key, { now: NOW });
		expect(eat.payload['key-attributes'].hardware).toBe(false);
		expect(eat.payload['key-attestation']).toBeUndefined();

		const result = await verifyProcessEvidence(eat, {
			trustAnchors: [key.publicJwk],
		});
		expect(result.valid).toBe(true);
		expect(result.hardwareRootOfTrust).toBe(false);
	});

	it('issue-time refuses hardware without a matching anchor (wrong anchor ⇒ software EAT)', async () => {
		const deploymentKey = await edKey();
		const attestor = await edKey();
		const wrongAnchor = await edKey();
		const att = await signKeyAttestation(deploymentKey.publicJwk, DEVICE, attestor, NOW);

		const eat = await signProcessEvidence(EVIDENCE, deploymentKey, {
			now: NOW,
			keyAttestation: att,
			keyAttestationAnchors: [wrongAnchor.publicJwk],
		});
		expect(eat.payload['key-attributes'].hardware).toBe(false);
		expect(eat.payload['key-attestation']).toBeUndefined();
	});

	it('verify-time hardwareRootOfTrust is false without supplied trust anchors', async () => {
		const deploymentKey = await edKey();
		const attestor = await edKey();
		const att = await signKeyAttestation(deploymentKey.publicJwk, DEVICE, attestor, NOW);
		const eat = await signProcessEvidence(EVIDENCE, deploymentKey, {
			now: NOW,
			keyAttestation: att,
			keyAttestationAnchors: [attestor.publicJwk],
		});
		// Issuer set hardware:true, but a verifier that does not configure the anchor must NOT trust it.
		const result = await verifyProcessEvidence(eat, {});
		expect(result.valid).toBe(true);
		expect(result.hardwareRootOfTrust).toBe(false);
	});

	it('PoP challenge carries hardwareRootOfTrust through the same gate', async () => {
		const attestor = await edKey();
		const eatKey = await edKey();
		const subjectKey = await edKey();
		const att = await signKeyAttestation(subjectKey.publicJwk, DEVICE, attestor, NOW);
		const nonce = 'nonce-hw-1';

		// answerPopChallenge does not thread attestation options, so sign the EAT+PoP explicitly.
		const eat = await signProcessEvidence(EVIDENCE, eatKey, {
			now: NOW,
			nonce,
			subjectPublicJwk: subjectKey.publicJwk,
			keyAttestation: att,
			keyAttestationAnchors: [attestor.publicJwk],
		});
		const { pop } = await answerPopChallenge(EVIDENCE, eatKey, subjectKey, {
			now: NOW,
			nonce,
		});

		const anchored = await verifyPopChallenge(eat, pop, nonce, {
			trustAnchors: [attestor.publicJwk],
		});
		expect(anchored.valid).toBe(true);
		expect(anchored.hardwareRootOfTrust).toBe(true);

		const unanchored = await verifyPopChallenge(eat, pop, nonce);
		expect(unanchored.valid).toBe(true);
		expect(unanchored.hardwareRootOfTrust).toBe(false);
	});
});
