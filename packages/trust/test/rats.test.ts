// P4.10: RATS process-evidence EAT. Issue → verify (with key binding), tamper a claim → fail, wrong
// nonce → fail, wrong key → fail. Software attestation only (no hardware root of trust).

import { describe, expect, it } from 'vitest';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';
import { type ProcessEvidence, signProcessEvidence, verifyProcessEvidence } from '../src/rats.js';

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
});
