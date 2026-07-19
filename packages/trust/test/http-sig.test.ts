// RFC 9421 HTTP Message Signatures: sign a response body, verify it, and confirm tampering the body
// or the covered content-type breaks verification. Runs in workerd (Web Crypto raw sign/verify).

import { describe, expect, it } from 'vitest';
import { parseSignatureParams, signResponse, verifyResponse } from '../src/http-sig.js';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';

const enc = new TextEncoder();
const CT = 'application/json';

async function fixture(alg: 'EdDSA' | 'ES256') {
	const { privateJwk, publicJwk } = await generateSigningJwk(alg);
	const key = await loadSigningKey(JSON.stringify(privateJwk));
	return { key, publicJwk };
}

describe('RFC 9421 signResponse/verifyResponse', () => {
	for (const alg of ['EdDSA', 'ES256'] as const) {
		it(`round-trips a signed response with ${alg}`, async () => {
			const { key, publicJwk } = await fixture(alg);
			const body = enc.encode(JSON.stringify({ site: 'a', visitors: 42 }));
			const headers = await signResponse({
				body,
				contentType: CT,
				created: 1_770_000_000,
				key,
			});

			expect(headers['content-digest']).toMatch(/^sha-256=:.+:$/);
			expect(headers['signature-input']).toContain('keyid="');
			expect(
				parseSignatureParams(headers['signature-input'].split('=').slice(1).join('=')).alg,
			).toBe(alg === 'EdDSA' ? 'ed25519' : 'ecdsa-p256-sha256');

			const ok = await verifyResponse({
				body,
				contentType: CT,
				contentDigest: headers['content-digest'],
				signatureInput: headers['signature-input'],
				signature: headers.signature,
				publicJwk,
			});
			expect(ok).toBe(true);
		});
	}

	it('fails when the body is tampered', async () => {
		const { key, publicJwk } = await fixture('EdDSA');
		const body = enc.encode(JSON.stringify({ visitors: 42 }));
		const headers = await signResponse({
			body,
			contentType: CT,
			created: 1_770_000_000,
			key,
		});
		const ok = await verifyResponse({
			body: enc.encode(JSON.stringify({ visitors: 9999 })),
			contentType: CT,
			contentDigest: headers['content-digest'],
			signatureInput: headers['signature-input'],
			signature: headers.signature,
			publicJwk,
		});
		expect(ok).toBe(false);
	});

	it('fails when a covered component (content-type) is changed', async () => {
		const { key, publicJwk } = await fixture('EdDSA');
		const body = enc.encode('x');
		const headers = await signResponse({
			body,
			contentType: CT,
			created: 1_770_000_000,
			key,
		});
		const ok = await verifyResponse({
			body,
			contentType: 'text/csv',
			contentDigest: headers['content-digest'],
			signatureInput: headers['signature-input'],
			signature: headers.signature,
			publicJwk,
		});
		expect(ok).toBe(false);
	});

	it('fails under a rotated key', async () => {
		const { key } = await fixture('EdDSA');
		const other = await generateSigningJwk('EdDSA');
		const body = enc.encode('x');
		const headers = await signResponse({
			body,
			contentType: CT,
			created: 1_770_000_000,
			key,
		});
		const ok = await verifyResponse({
			body,
			contentType: CT,
			contentDigest: headers['content-digest'],
			signatureInput: headers['signature-input'],
			signature: headers.signature,
			publicJwk: other.publicJwk,
		});
		expect(ok).toBe(false);
	});
});
