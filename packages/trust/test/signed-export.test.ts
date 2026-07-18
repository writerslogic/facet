// Canonicalization + signed-export envelope: JCS is stable across key order, and a signed export
// verifies offline, fails on any payload tamper, and fails under a rotated key.

import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../src/canonicalize.js';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';
import { type SignedExport, signExport, verifySignedExport } from '../src/signed-export.js';

const PAYLOAD = {
	columns: ['bucket_start_iso', 'pageviews', 'visitors'],
	rows: [
		['2026-07-01T00:00:00.000Z', 120, 84],
		['2026-07-01T01:00:00.000Z', 96, 71],
	],
};

describe('canonicalizeJson (RFC 8785)', () => {
	it('is independent of key insertion order', () => {
		expect(canonicalizeJson({ b: 1, a: 2 })).toBe(canonicalizeJson({ a: 2, b: 1 }));
		expect(canonicalizeJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
	});
	it('drops undefined members and preserves array order', () => {
		expect(canonicalizeJson({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}');
	});
	it('rejects non-finite numbers', () => {
		expect(() => canonicalizeJson({ x: Number.POSITIVE_INFINITY })).toThrow();
	});
});

describe('signExport / verifySignedExport', () => {
	async function key(alg: 'EdDSA' | 'ES256') {
		const { privateJwk } = await generateSigningJwk(alg);
		return loadSigningKey(JSON.stringify(privateJwk));
	}

	for (const alg of ['EdDSA', 'ES256'] as const) {
		it(`signs and verifies offline with ${alg}`, async () => {
			const k = await key(alg);
			const env = await signExport(PAYLOAD, k, {
				jwksUrl: 'https://facet.example/.well-known/jwks.json',
				now: Date.UTC(2026, 6, 1),
			});
			expect(env.facet).toBe('facet-signed-export/1');
			expect(env.proof.kid).toBe(k.kid);
			const res = await verifySignedExport(env);
			expect(res.valid).toBe(true);
			expect(res.kid).toBe(k.kid);
			expect(res.jwksUrl).toBe('https://facet.example/.well-known/jwks.json');
		});
	}

	it('fails when the payload is tampered', async () => {
		const k = await key('EdDSA');
		const env = await signExport(PAYLOAD, k, { now: 0 });
		const tampered: SignedExport = {
			...env,
			payload: {
				...PAYLOAD,
				rows: [['2026-07-01T00:00:00.000Z', 999999, 84]],
			},
		};
		const res = await verifySignedExport(tampered);
		expect(res.valid).toBe(false);
		expect(res.reason).toBeDefined();
	});

	it('fails when the embedded key is swapped for another', async () => {
		const k = await key('EdDSA');
		const other = await generateSigningJwk('EdDSA');
		const env = await signExport(PAYLOAD, k, { now: 0 });
		const swapped: SignedExport = {
			...env,
			proof: { ...env.proof, publicJwk: other.publicJwk },
		};
		const res = await verifySignedExport(swapped);
		expect(res.valid).toBe(false);
	});

	it('rejects an unrecognized envelope type', async () => {
		const k = await key('EdDSA');
		const env = await signExport(PAYLOAD, k, { now: 0 });
		const res = await verifySignedExport({
			...env,
			facet: 'nope',
		} as unknown as SignedExport);
		expect(res.valid).toBe(false);
		expect(res.reason).toContain('unrecognized');
	});
});
