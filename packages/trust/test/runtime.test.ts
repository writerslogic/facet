// Runtime reality check (invariant 4): prove jose's Ed25519 and ECDSA P-256 sign/verify paths run in
// the real workerd runtime before any feature depends on them. If jose could not run here, these
// tests would fail at import/sign time and the whole trust layer would be gated.

import { describe, expect, it } from 'vitest';
import { signDetachedJws, verifyDetachedJws } from '../src/jws.js';
import { generateSigningJwk, importPublicJwk, loadSigningKey } from '../src/keys.js';

const enc = new TextEncoder();

describe('jose runs under workerd', () => {
	for (const alg of ['EdDSA', 'ES256'] as const) {
		it(`generates, loads, and round-trips a detached JWS with ${alg}`, async () => {
			const { privateJwk, publicJwk } = await generateSigningJwk(alg);
			expect(privateJwk.d).toBeTruthy();
			expect(publicJwk.d).toBeUndefined();
			expect(publicJwk.kid).toBe(privateJwk.kid);

			const key = await loadSigningKey(JSON.stringify(privateJwk));
			expect(key.alg).toBe(alg);
			expect(key.kid).toBe(publicJwk.kid);

			const payload = enc.encode('deployment=facet;report=2026-07');
			const detached = await signDetachedJws(payload, key);
			expect(detached.split('.')[1]).toBe('');

			const { protectedHeader } = await verifyDetachedJws(detached, payload, publicJwk);
			expect(protectedHeader.alg).toBe(alg);
			expect(protectedHeader.kid).toBe(key.kid);
		});
	}

	it('fails verification when the payload is tampered', async () => {
		const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
		const key = await loadSigningKey(JSON.stringify(privateJwk));
		const detached = await signDetachedJws(enc.encode('total=100'), key);
		await expect(
			verifyDetachedJws(detached, enc.encode('total=999'), publicJwk),
		).rejects.toThrow();
	});

	it('fails verification under a different (rotated) key', async () => {
		const a = await generateSigningJwk('EdDSA');
		const b = await generateSigningJwk('EdDSA');
		const key = await loadSigningKey(JSON.stringify(a.privateJwk));
		const payload = enc.encode('total=100');
		const detached = await signDetachedJws(payload, key);
		// Same payload, wrong public key → must not verify.
		await expect(verifyDetachedJws(detached, payload, b.publicJwk)).rejects.toThrow();
		// Correct key still verifies.
		await expect(verifyDetachedJws(detached, payload, a.publicJwk)).resolves.toBeDefined();
	});

	it('imports a public JWK as a CryptoKey', async () => {
		const { publicJwk } = await generateSigningJwk('ES256');
		const { key, alg } = await importPublicJwk(publicJwk);
		expect(key).toBeInstanceOf(CryptoKey);
		expect(alg).toBe('ES256');
	});
});
