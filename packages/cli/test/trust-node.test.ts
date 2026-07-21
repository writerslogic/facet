// Regression (#1): @facet/trust's raw crypto.subtle verify paths — COSE_Sign1 and RFC 9421 HTTP Message
// Signatures — must work under Node, not only workerd. Before `importVerifyKey`, verification imported
// the public JWK via jose (a Node KeyObject) and passed it to crypto.subtle.verify, which throws in Node,
// so every COSE/HTTP-sig verification failed. This suite runs in the CLI's Node runtime.

import {
	generateSigningJwk,
	loadSigningKey,
	signKeyAttestation,
	signResponse,
	signStatementCose,
	verifyKeyAttestation,
	verifyResponse,
	verifyStatement,
} from '@facet/trust';
import { describe, expect, it } from 'vitest';

async function key(alg: 'EdDSA' | 'ES256') {
	const { privateJwk } = await generateSigningJwk(alg);
	return loadSigningKey(JSON.stringify(privateJwk));
}

describe('trust raw-crypto verification under Node', () => {
	for (const alg of ['EdDSA', 'ES256'] as const) {
		it(`verifies a COSE_Sign1 statement in Node (${alg})`, async () => {
			const k = await key(alg);
			const stmt = await signStatementCose('facet-test/1', { a: 1, b: [2, 3] }, k, 0);
			expect((await verifyStatement(stmt, 'facet-test/1')).valid).toBe(true);
		});

		it(`verifies an RFC 9421 signed response in Node (${alg})`, async () => {
			const k = await key(alg);
			const body = new TextEncoder().encode('{"ok":true}');
			const headers = await signResponse({
				body,
				contentType: 'application/json',
				created: 1,
				key: k,
			});
			const ok = await verifyResponse({
				body,
				contentType: 'application/json',
				contentDigest: headers['content-digest'],
				signatureInput: headers['signature-input'],
				signature: headers.signature,
				publicJwk: k.publicJwk,
			});
			expect(ok).toBe(true);
		});
	}

	it('verifies a hardware key-attestation in Node', async () => {
		const attestor = await key('EdDSA');
		const subject = await key('EdDSA');
		const att = await signKeyAttestation(
			subject.publicJwk,
			{ deviceClass: 'hsm', vendor: 'ACME' },
			attestor,
			0,
		);
		const res = await verifyKeyAttestation(att, {
			trustAnchors: [attestor.publicJwk],
		});
		expect(res.hardware).toBe(true);
	});
});
