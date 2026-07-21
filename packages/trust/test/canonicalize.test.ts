// RFC 8785 (JSON Canonicalization Scheme) conformance for canonicalizeJson — the byte-exact form that
// a signer and verifier must agree on (it feeds every Data Integrity, SCITT, RATS, and MMR-leaf hash).
// The load-bearing cases are property-name ordering by UTF-16 code unit (including surrogate pairs,
// where a code-POINT sort would diverge) and ECMAScript number serialization. Runs in workerd.

import { describe, expect, it } from 'vitest';
import { canonicalDigestHex, canonicalizeBytes, canonicalizeJson } from '../src/canonicalize.js';

describe('RFC 8785 canonicalization', () => {
	it('orders property names by UTF-16 code unit (RFC 8785 §3.2.3 example)', () => {
		// Keys built from explicit code points (not editor literals, which can decompose): CR (U+000D),
		// "1" (U+0031), U+0080, ö (U+00F6), € (U+20AC), 😀 (U+1F600 → surrogate lead U+D83D), and the
		// PRECOMPOSED Hebrew dalet+dagesh (U+FB33). Sorting by code UNIT places the emoji (lead unit
		// D83D) BEFORE U+FB33 — a code-POINT sort would place it last and fail JCS.
		const cr = String.fromCharCode(0x000d);
		const control = String.fromCharCode(0x0080);
		const oDiaeresis = String.fromCharCode(0x00f6);
		const euro = String.fromCharCode(0x20ac);
		const emoji = String.fromCodePoint(0x1f600);
		const dalet = String.fromCharCode(0xfb33);
		const input = {
			[euro]: 'Euro',
			[cr]: 'Carriage Return',
			[dalet]: 'Hebrew Dalet+Dagesh',
			'1': 'One',
			[emoji]: 'Grinning Face',
			[control]: 'Control',
			[oDiaeresis]: 'o-diaeresis',
		};
		const canonical = canonicalizeJson(input);
		const keyOrder = [...canonical.matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => m[1]);
		// As captured from the JSON: CR escapes to "\\r"; the others appear as their literal characters.
		expect(keyOrder).toEqual(['\\r', '1', control, oDiaeresis, euro, emoji, dalet]);
	});

	it('sorts keys recursively while preserving array element order', () => {
		const out = canonicalizeJson({
			b: 1,
			a: { z: [3, 1, 2], y: 0 },
		});
		// Object keys sort (a before b, y before z); array [3,1,2] keeps its order.
		expect(out).toBe('{"a":{"y":0,"z":[3,1,2]},"b":1}');
	});

	it('serializes numbers in ECMAScript Number-to-String form', () => {
		// RFC 8785 §3.2.2.3 mandates the ECMAScript ToString(Number) form; assert the canonical spellings
		// for the domain (integers, decimals) plus the exponent boundaries the header comment hedged on.
		expect(canonicalizeJson({ n: 4.5 })).toBe('{"n":4.5}');
		expect(canonicalizeJson({ n: 0.002 })).toBe('{"n":0.002}');
		expect(canonicalizeJson({ n: 1000000 })).toBe('{"n":1000000}');
		expect(canonicalizeJson({ n: 1e30 })).toBe('{"n":1e+30}');
		expect(canonicalizeJson({ n: 1e-27 })).toBe('{"n":1e-27}');
		// Trailing zeros are stripped and an integral value never keeps a ".0".
		expect(canonicalizeJson({ n: 100.1 })).toBe('{"n":100.1}');
		expect(canonicalizeJson({ n: 1.0 })).toBe('{"n":1}');
	});

	it('renders negative zero as "0" (RFC 8785 sign-of-zero rule)', () => {
		expect(canonicalizeJson({ n: -0 })).toBe('{"n":0}');
	});

	it('rejects non-finite numbers rather than emitting null', () => {
		// JSON.stringify would turn these into `null`; a signable canonical form must refuse them.
		expect(() => canonicalizeJson({ n: Number.NaN })).toThrow();
		expect(() => canonicalizeJson({ n: Number.POSITIVE_INFINITY })).toThrow();
		expect(() => canonicalizeJson(Number.NEGATIVE_INFINITY)).toThrow();
	});

	it('omits undefined-valued members so JS input is signable', () => {
		// `undefined` has no JSON form; eliding the member keeps the canonical string stable rather than
		// letting it leak in and break signer/verifier agreement.
		expect(canonicalizeJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
	});

	it('canonicalizeBytes is the UTF-8 encoding of the canonical string', () => {
		const value = { n: 4.5, s: 'euro' };
		expect(canonicalizeBytes(value)).toEqual(new TextEncoder().encode(canonicalizeJson(value)));
	});

	it('canonicalDigest is invariant to input key order (the whole point of canonicalization)', async () => {
		const a = await canonicalDigestHex({ x: 1, y: { b: 2, a: 3 } });
		const b = await canonicalDigestHex({ y: { a: 3, b: 2 }, x: 1 });
		expect(a).toBe(b);
	});
});
