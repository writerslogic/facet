// P4.10: RATS process-evidence EAT. Issue → verify (with key binding), tamper a claim → fail, wrong
// nonce → fail, wrong key → fail. Software attestation only (no hardware root of trust).

import { describe, expect, it } from 'vitest';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';
import {
	type ProcessEvidence,
	answerPopChallenge,
	signProcessEvidence,
	verifyPopChallenge,
	verifyProcessEvidence,
} from '../src/rats.js';

const EVIDENCE: ProcessEvidence = {
	buildId: 'ci-99',
	commit: 'abc1234',
	schemaHash: 'f'.repeat(64),
	wranglerHash: 'a'.repeat(64),
	privacyTransforms: [
		'daily-rotating-salted-sha256',
		'no-raw-ip-storage',
		'cookieless',
		'gpc-honored',
	],
};

async function edKey() {
	const { privateJwk } = await generateSigningJwk('EdDSA');
	return loadSigningKey(JSON.stringify(privateJwk));
}

describe('RATS process-evidence', () => {
	it('issues and verifies, producing a key-bound attestation result', async () => {
		const key = await edKey();
		const eat = await signProcessEvidence(EVIDENCE, key, {
			now: 1_770_000_000_000,
		});
		expect(eat.payload.eat_profile).toBe(
			'urn:ietf:params:rats:eat:profile:process-evidence:1.0',
		);
		expect(eat.payload['key-attributes'].hardware).toBe(false);

		const result = await verifyProcessEvidence(eat);
		expect(result.valid).toBe(true);
		expect(result.keyBound).toBe(true);
		expect(result.evidence?.buildId).toBe('ci-99');
	});

	it('fails when a claim is tampered', async () => {
		const key = await edKey();
		const eat = await signProcessEvidence(EVIDENCE, key, {
			now: 1_770_000_000_000,
		});
		eat.payload['process-evidence'].schemaHash = '0'.repeat(64);
		const result = await verifyProcessEvidence(eat);
		expect(result.valid).toBe(false);
	});

	it('enforces a verifier-supplied nonce', async () => {
		const key = await edKey();
		const eat = await signProcessEvidence(EVIDENCE, key, {
			now: 1_770_000_000_000,
			nonce: 'n-123',
		});
		expect((await verifyProcessEvidence(eat, { nonce: 'n-123' })).valid).toBe(true);
		expect((await verifyProcessEvidence(eat, { nonce: 'wrong' })).valid).toBe(false);
	});

	it('fails key binding when the cnf key is swapped', async () => {
		const key = await edKey();
		const other = await generateSigningJwk('EdDSA');
		const eat = await signProcessEvidence(EVIDENCE, key, {
			now: 1_770_000_000_000,
		});
		eat.payload.cnf = { jwk: other.publicJwk };
		const result = await verifyProcessEvidence(eat);
		expect(result.valid).toBe(false);
		expect(result.keyBound).toBe(false);
	});

	it('rejects a cnf whose kid LABEL is spoofed to the signer but whose key material differs', async () => {
		// The forgery the old kid-string binding allowed: sign with your own key, then set cnf to the
		// VICTIM's key material carrying the SIGNER's kid label. Binding by RFC 7638 thumbprint of the
		// actual key material (not the self-asserted kid) must reject it.
		const key = await edKey();
		const victim = await generateSigningJwk('EdDSA');
		const eat = await signProcessEvidence(EVIDENCE, key, {
			now: 1_770_000_000_000,
		});
		eat.payload.cnf = { jwk: { ...victim.publicJwk, kid: key.kid } };
		const result = await verifyProcessEvidence(eat);
		expect(result.keyBound).toBe(false);
		expect(result.valid).toBe(false);
	});

	it('returns a clean failure (never throws) when cnf.jwk is a malformed JWK', async () => {
		const key = await edKey();
		const eat = await signProcessEvidence(EVIDENCE, key, {
			now: 1_770_000_000_000,
		});
		// Attacker payload: cnf.jwk is not a valid JWK. Thumbprinting it must not throw out of verify.
		eat.payload.cnf = { jwk: {} };
		const result = await verifyProcessEvidence(eat);
		expect(result.valid).toBe(false);
		expect(result.keyBound).toBe(false);
	});
});

describe('RATS challenge-response proof-of-possession', () => {
	const NONCE = 'verifier-nonce-abc123';

	it('succeeds when the PoP is signed by the cnf subject key over the challenge nonce', async () => {
		const eatKey = await edKey();
		const subjectKey = await edKey();
		const { eat, pop } = await answerPopChallenge(EVIDENCE, eatKey, subjectKey, {
			now: 1_770_000_000_000,
			nonce: NONCE,
		});
		const result = await verifyPopChallenge(eat, pop, NONCE);
		expect(result.valid).toBe(true);
		expect(result.eatValid).toBe(true);
		expect(result.popValid).toBe(true);
		expect(result.evidence?.buildId).toBe('ci-99');
	});

	it('works with a single self-attesting key (subject == eat key)', async () => {
		const key = await edKey();
		const { eat, pop } = await answerPopChallenge(EVIDENCE, key, key, {
			now: 1_770_000_000_000,
			nonce: NONCE,
		});
		expect((await verifyPopChallenge(eat, pop, NONCE)).valid).toBe(true);
	});

	it('fails when the challenge nonce does not match the EAT/PoP nonce', async () => {
		const key = await edKey();
		const { eat, pop } = await answerPopChallenge(EVIDENCE, key, key, {
			now: 1_770_000_000_000,
			nonce: NONCE,
		});
		const result = await verifyPopChallenge(eat, pop, 'different-nonce');
		expect(result.valid).toBe(false);
	});

	it('fails when the PoP is signed by the wrong key', async () => {
		const eatKey = await edKey();
		const subjectKey = await edKey();
		const attacker = await edKey();
		// Attacker forges a PoP over the real challenge but with THEIR key, and swaps the pop.publicJwk.
		const { eat, pop } = await answerPopChallenge(EVIDENCE, eatKey, subjectKey, {
			now: 1_770_000_000_000,
			nonce: NONCE,
		});
		const forged = await answerPopChallenge(EVIDENCE, eatKey, attacker, {
			now: 1_770_000_000_000,
			nonce: NONCE,
		});
		// Keep the genuine EAT (cnf = subjectKey) but attach the attacker's PoP.
		const result = await verifyPopChallenge(eat, forged.pop, NONCE);
		expect(result.valid).toBe(false);
		expect(result.popValid).toBe(false);
		// And even swapping pop.publicJwk to the attacker key must not help: verify uses the EAT's cnf.
		const swapped = {
			...pop,
			jws: forged.pop.jws,
			publicJwk: attacker.publicJwk,
		};
		expect((await verifyPopChallenge(eat, swapped, NONCE)).valid).toBe(false);
	});
});
