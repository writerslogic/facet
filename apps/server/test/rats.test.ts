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

/** A conformant verifier nonce (RFC 9711 sizes a JSON `eat_nonce` at 8..88 bytes). */
const NONCE = 'nonce-0123456789abcdef';

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
			`https://facet.example/api/attestation/evidence?nonce=${NONCE}`,
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

		const result = await verifyProcessEvidence(eat, { nonce: NONCE });
		expect(result.valid).toBe(true);
		expect(result.keyBound).toBe(true);
		// A different nonce must fail freshness.
		expect((await verifyProcessEvidence(eat, { nonce: 'wrong-but-long-enough' })).valid).toBe(
			false,
		);
	});

	it('rejects a nonce outside the RFC 9711 bounds instead of signing it', async () => {
		// `nonce` is the only request-derived value either attestation route takes, and it is copied
		// verbatim into a signed claim. RFC 9711 sizes a JSON `eat_nonce` at 8..88 bytes, so anything
		// else produces an EAT that a conformant verifier refuses — signed by this deployment, failing
		// in the caller's stack, for a reason nothing in the response explains. `?nonce=` is the same
		// case at zero length: it reaches the handler as '' rather than undefined, and used to be
		// accepted and then silently dropped from the claim set.
		for (const q of ['nonce=short', 'nonce=', `nonce=${'a'.repeat(89)}`]) {
			const res = await createApp().request(
				`https://facet.example/api/attestation/evidence?${q}`,
				{},
				signingEnv,
			);
			expect(res.status).toBe(400);
			// The reason travels with the code. A bare `bad_request` on the one parameter the route
			// takes leaves the caller guessing at a bound that is published in an RFC.
			expect((await res.json()) as { error: string; message?: string }).toMatchObject({
				error: 'bad_request',
				message: expect.stringContaining('RFC 9711'),
			});
		}
	});

	it('accepts the exact boundary lengths', async () => {
		for (const n of [8, 88]) {
			const res = await createApp().request(
				`https://facet.example/api/attestation/evidence?nonce=${'a'.repeat(n)}`,
				{},
				signingEnv,
			);
			expect(res.status).toBe(200);
			const eat = (await res.json()) as SignedStatement<EatClaims>;
			expect(eat.payload.eat_nonce).toBe('a'.repeat(n));
		}
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
