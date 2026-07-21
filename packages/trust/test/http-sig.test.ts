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

/** Standard base64 of raw bytes, computed without touching the implementation under test. */
function b64(bytes: Uint8Array): string {
	let s = '';
	for (const byte of bytes) s += String.fromCharCode(byte);
	return btoa(s);
}

describe('RFC 9421 conformance (independent signature-base reconstruction)', () => {
	// Rebuild the §2.5 signature base, §2.3 signature params, and RFC 9530 content-digest here from the
	// RFC's own rules — NOT from http-sig.ts — then sign the base with the same key via Web Crypto
	// directly. Ed25519 is deterministic, so if the implementation assembles the base exactly as the RFC
	// prescribes, its emitted signature must equal this independently produced one, byte for byte.
	it('signResponse output matches a from-scratch RFC 9421 construction', async () => {
		const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
		const key = await loadSigningKey(JSON.stringify(privateJwk));
		const body = enc.encode(JSON.stringify({ site: 'a', visitors: 42 }));
		const created = 1_770_000_000;

		// Independent RFC 9530 Content-Digest: sha-256=:<base64(SHA-256(body))>:
		const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
		const contentDigest = `sha-256=:${b64(digestBytes)}:`;

		// Independent §2.3 signature params + §2.5 base string (covered components in fixed order).
		const params = `("content-digest" "content-type");created=${created};keyid="${key.kid}";alg="ed25519"`;
		const base = [
			`"content-digest": ${contentDigest}`,
			`"content-type": ${CT}`,
			`"@signature-params": ${params}`,
		].join('\n');

		// Independent Ed25519 signature over the base, using the same private key material.
		const priv = await crypto.subtle.importKey(
			'jwk',
			privateJwk as unknown as JsonWebKey,
			{ name: 'Ed25519' },
			false,
			['sign'],
		);
		const expectedSig = new Uint8Array(
			await crypto.subtle.sign({ name: 'Ed25519' }, priv, enc.encode(base)),
		);

		const headers = await signResponse({
			body,
			contentType: CT,
			created,
			key,
		});

		expect(headers['content-digest']).toBe(contentDigest);
		expect(headers['signature-input']).toBe(`sig1=${params}`);
		expect(headers.signature).toBe(`sig1=:${b64(expectedSig)}:`);

		// And the independently produced signature verifies through the implementation's verify path.
		const ok = await verifyResponse({
			body,
			contentType: CT,
			contentDigest,
			signatureInput: `sig1=${params}`,
			signature: `sig1=:${b64(expectedSig)}:`,
			publicJwk,
		});
		expect(ok).toBe(true);
	});
});
