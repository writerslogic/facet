// COSE_Sign1 (RFC 9052) proven in the real workerd runtime: sign→verify, tamper→fail, wrong-key→fail,
// for both EdDSA and ES256. Also checks the encoded message is a CBOR tag-18 structure and that the
// protected header carries the correct COSE alg id + kid, and cross-checks against a fixed known-answer
// vector so a silent encoding drift is caught.

import { decode as cborDecode } from 'cborg';
import { describe, expect, it } from 'vitest';
import { toHex } from '../src/bytes.js';
import { inspectCoseSign1, signCoseSign1, verifyCoseSign1 } from '../src/cose.js';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';

const enc = new TextEncoder();

describe('COSE_Sign1 in workerd', () => {
	for (const alg of ['EdDSA', 'ES256'] as const) {
		it(`signs and verifies with ${alg}`, async () => {
			const { privateJwk, publicJwk } = await generateSigningJwk(alg);
			const key = await loadSigningKey(JSON.stringify(privateJwk));
			const payload = enc.encode('deployment=facet;report=2026-07');

			const msg = await signCoseSign1(payload, key);
			expect(msg).toBeInstanceOf(Uint8Array);

			const result = await verifyCoseSign1(msg, publicJwk);
			expect(result.protectedHeader.alg).toBe(alg);
			expect(result.protectedHeader.kid).toBe(key.kid);
			expect([...result.payload]).toEqual([...payload]);
		});

		it(`fails verification when the message is tampered (${alg})`, async () => {
			const { privateJwk, publicJwk } = await generateSigningJwk(alg);
			const key = await loadSigningKey(JSON.stringify(privateJwk));
			const payload = enc.encode('total=100');
			const msg = await signCoseSign1(payload, key);

			// Flip the last byte (inside the trailing signature bstr): CBOR shape is preserved, so decode
			// succeeds but the signature check must reject.
			const tampered = msg.slice();
			const last = tampered.length - 1;
			tampered[last] = (tampered[last] as number) ^ 0xff;
			await expect(verifyCoseSign1(tampered, publicJwk)).rejects.toThrow();

			// Flip a payload byte: locate the "total=100" run and mutate it in place.
			const idx = msg.findIndex(
				(_, i) =>
					msg[i] === payload[0] && msg[i + 1] === payload[1] && msg[i + 2] === payload[2],
			);
			const tampered2 = msg.slice();
			tampered2[idx] = (tampered2[idx] as number) ^ 0xff;
			await expect(verifyCoseSign1(tampered2, publicJwk)).rejects.toThrow();
		});

		it(`fails verification under a rotated key (${alg})`, async () => {
			const a = await generateSigningJwk(alg);
			const b = await generateSigningJwk(alg);
			const key = await loadSigningKey(JSON.stringify(a.privateJwk));
			const msg = await signCoseSign1(enc.encode('total=100'), key);
			await expect(verifyCoseSign1(msg, b.publicJwk)).rejects.toThrow();
			await expect(verifyCoseSign1(msg, a.publicJwk)).resolves.toBeDefined();
		});
	}

	it('encodes as a CBOR tag-18 COSE_Sign1 with alg (-8) + kid in the protected header', async () => {
		const { privateJwk } = await generateSigningJwk('EdDSA');
		const key = await loadSigningKey(JSON.stringify(privateJwk));
		const msg = await signCoseSign1(enc.encode('x'), key);
		// First byte 0xd2 = CBOR major type 6 (tag), value 18 (COSE_Sign1).
		expect(msg[0]).toBe(0xd2);
		// Decode with tag 18 passing its array through, integer map keys → JS Map.
		const tags: ((inner: unknown) => unknown)[] = [];
		tags[18] = (inner) => inner;
		const arr = cborDecode(msg, { useMaps: true, tags }) as unknown[];
		const protectedMap = cborDecode(arr[0] as Uint8Array, {
			useMaps: true,
		}) as Map<number, unknown>;
		expect(protectedMap.get(1)).toBe(-8);
		expect(new TextDecoder().decode(protectedMap.get(4) as Uint8Array)).toBe(key.kid);
	});

	it('inspect reads the header + payload without verifying', async () => {
		const { privateJwk } = await generateSigningJwk('ES256');
		const key = await loadSigningKey(JSON.stringify(privateJwk));
		const msg = await signCoseSign1(enc.encode('hello'), key);
		const insp = inspectCoseSign1(msg);
		expect(insp.protectedHeader.alg).toBe('ES256');
		expect(new TextDecoder().decode(insp.payload)).toBe('hello');
	});

	it('matches a pinned deterministic EdDSA known-answer vector', async () => {
		// EdDSA (RFC 8032) is deterministic, so a fixed key + fixed payload yields a fixed COSE_Sign1.
		// This pins the exact CBOR/COSE byte layout so a silent encoding drift (map ordering, tag head,
		// Sig_structure) is caught. The vector was produced by this same code and re-verified below.
		const privateJwk = {
			kty: 'OKP',
			crv: 'Ed25519',
			x: 'plQLtyUhQYp4zvNm50t_EwW8cpdemy1-GWLa14U5uVk',
			d: 'PJRzsrRVUQCv1myG0wEHSlwqgFR-vZ7hd69nDcYAV8M',
			alg: 'EdDSA',
			kid: 'lt7GL4YJG6qxchrxs9CJ3SjNF2VG9dd4wEmLu97wOK0',
		};
		const expectedHex =
			'd2845831a2012704582b6c7437474c34594a47367178636872787339434a33536a4e463256473964643477456d4c753937774f4b30a054546869732069732074686520636f6e74656e742e5840909ffeeab993d2c0703c1a0d80ced24a54aba5158317dc3960f68ab57f014d27300eaf27350ddd7f15e38e5a65f02c7c306a4b1f4cc8b9ef654de10755e64407';
		const key = await loadSigningKey(JSON.stringify(privateJwk));
		const msg = await signCoseSign1(enc.encode('This is the content.'), key);
		expect(toHex(msg)).toBe(expectedHex);
		const result = await verifyCoseSign1(msg, {
			kty: 'OKP',
			crv: 'Ed25519',
			alg: 'EdDSA',
			x: privateJwk.x,
			kid: privateJwk.kid,
		});
		expect(new TextDecoder().decode(result.payload)).toBe('This is the content.');
	});
});
