// P4.10: RATS process-evidence endpoint + credential reference. /api/attestation/evidence issues a
// signed EAT (software attestation only) that verifies with key binding and an optional verifier
// nonce; the PrivacyAttestationCredential references the evidence's content-ref digest. 501 without a
// signing key.

import { env } from 'cloudflare:test';
import {
	type EatClaims,
	type SignedStatement,
	type VerifiableCredential,
	generateSigningJwk,
	verifyProcessEvidence,
} from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

let signingEnv: typeof env & { FACET_SIGNING_JWK: string };

beforeEach(async () => {
	const gen = await generateSigningJwk('EdDSA');
	signingEnv = {
		...env,
		FACET_SIGNING_JWK: JSON.stringify(gen.privateJwk),
		FACET_BUILD_ID: 'ci-77',
		FACET_WRANGLER_HASH: 'c'.repeat(64),
	};
});

describe('GET /api/attestation/evidence', () => {
	it('issues a key-bound EAT that verifies with a nonce', async () => {
		const res = await createApp().request(
			'https://facet.example/api/attestation/evidence?nonce=abc123',
			{},
			signingEnv,
		);
		expect(res.status).toBe(200);
		const eat = (await res.json()) as SignedStatement<EatClaims>;
		expect(eat.payload.eat_profile).toBe(
			'urn:ietf:params:rats:eat:profile:process-evidence:1.0',
		);
		expect(eat.payload['process-evidence'].buildId).toBe('ci-77');
		expect(eat.payload['process-evidence'].wranglerHash).toBe('c'.repeat(64));

		const result = await verifyProcessEvidence(eat, { nonce: 'abc123' });
		expect(result.valid).toBe(true);
		expect(result.keyBound).toBe(true);
		// A different nonce must fail freshness.
		expect((await verifyProcessEvidence(eat, { nonce: 'wrong' })).valid).toBe(false);
	});

	it('501s when signing is unconfigured', async () => {
		const res = await createApp().request(
			'https://facet.example/api/attestation/evidence',
			{},
			env,
		);
		expect(res.status).toBe(501);
	});
});

describe('PrivacyAttestationCredential references the RATS evidence', () => {
	it('embeds a content-ref matching a freshly issued evidence digest', async () => {
		const vc = (await (
			await createApp().request(
				'https://facet.example/api/attestation/privacy',
				{},
				signingEnv,
			)
		).json()) as VerifiableCredential;
		const subject = vc.credentialSubject as {
			processEvidence?: {
				profile: string;
				contentRef: { alg: string; digest: string };
			};
		};
		expect(subject.processEvidence?.profile).toBe(
			'urn:ietf:params:rats:eat:profile:process-evidence:1.0',
		);
		expect(subject.processEvidence?.contentRef.digest).toMatch(/^[0-9a-f]{64}$/);

		// The referenced digest must equal the digest inside a fresh evidence EAT (deterministic inputs).
		const eat = (await (
			await createApp().request(
				'https://facet.example/api/attestation/evidence',
				{},
				signingEnv,
			)
		).json()) as SignedStatement<EatClaims>;
		expect(subject.processEvidence?.contentRef.digest).toBe(eat.payload['content-ref'].digest);
	});
});
