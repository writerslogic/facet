// P4.9: SCITT. POST /api/scitt/attestation wraps the PrivacyAttestation as a Signed Statement and
// registers it with the local Transparency-Service double, returning a Receipt whose signature and
// MMR inclusion proof both verify. Admin-gated; 501 without a signing key. This exercises the FORMAT +
// the local double; operating an external Transparency Service is a separate deployment concern.

import { env } from 'cloudflare:test';
import {
	type ScittReceiptPayload,
	type SignedStatement,
	generateSigningJwk,
	verifyScittReceipt,
	verifySignedStatement,
} from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const ADMIN = 'Bearer test-admin-token';
let signingEnv: typeof env & { FACET_SIGNING_JWK: string };

beforeEach(async () => {
	const gen = await generateSigningJwk('EdDSA');
	signingEnv = { ...env, FACET_SIGNING_JWK: JSON.stringify(gen.privateJwk) };
});

describe('POST /api/scitt/attestation', () => {
	it('registers the attestation and issues a verifiable receipt', async () => {
		const res = await createApp().request(
			'https://facet.example/api/scitt/attestation',
			{ method: 'POST', headers: { Authorization: ADMIN } },
			signingEnv,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			statement: SignedStatement;
			receipt: SignedStatement<ScittReceiptPayload>;
			external: unknown;
		};

		// The wrapped Signed Statement verifies as a SCITT statement.
		expect((await verifySignedStatement(body.statement)).valid).toBe(true);
		// The Receipt's signature + MMR inclusion proof both verify.
		const rv = await verifyScittReceipt(body.receipt);
		expect(rv.valid).toBe(true);
		expect(rv.logId).toBe('facet-scitt-local');
		// No external service configured → null.
		expect(body.external).toBeNull();
	});

	it('assigns increasing entry ids across registrations', async () => {
		const first = (await (
			await createApp().request(
				'https://facet.example/api/scitt/attestation',
				{ method: 'POST', headers: { Authorization: ADMIN } },
				signingEnv,
			)
		).json()) as { receipt: SignedStatement<ScittReceiptPayload> };
		const second = (await (
			await createApp().request(
				'https://facet.example/api/scitt/attestation',
				{ method: 'POST', headers: { Authorization: ADMIN } },
				signingEnv,
			)
		).json()) as { receipt: SignedStatement<ScittReceiptPayload> };
		expect(second.receipt.payload.entryId).toBe(first.receipt.payload.entryId + 1);
		expect(await (await verifyScittReceipt(second.receipt)).valid).toBe(true);
	});

	it('issues a COSE_Sign1 receipt when ?format=cose is requested', async () => {
		const res = await createApp().request(
			'https://facet.example/api/scitt/attestation?format=cose',
			{ method: 'POST', headers: { Authorization: ADMIN } },
			signingEnv,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			receipt: SignedStatement<ScittReceiptPayload>;
		};
		expect(body.receipt.proof.type).toBe('COSE_Sign1');
		const rv = await verifyScittReceipt(body.receipt);
		expect(rv.valid).toBe(true);
	});

	it('requires admin auth', async () => {
		const res = await createApp().request(
			'https://facet.example/api/scitt/attestation',
			{ method: 'POST' },
			signingEnv,
		);
		expect(res.status).toBe(401);
	});

	it('501s when signing is unconfigured', async () => {
		const res = await createApp().request(
			'https://facet.example/api/scitt/attestation',
			{ method: 'POST', headers: { Authorization: ADMIN } },
			env,
		);
		expect(res.status).toBe(501);
	});
});
