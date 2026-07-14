// T009: canonical crypto primitives — hex encoding, SHA-256, random hex, constant-time compare.

import { describe, expect, it } from 'vitest';
import { constantTimeEqualHex, randomHex, sha256Hex, toHex } from '../src/lib/crypto.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('sha256Hex', () => {
	it('matches the known SHA-256 of the empty string', async () => {
		expect(await sha256Hex('')).toBe(EMPTY_SHA256);
	});

	it('is 64 lowercase hex and deterministic', async () => {
		const a = await sha256Hex('hello');
		const b = await sha256Hex('hello');
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('toHex', () => {
	it('zero-pads each byte to two lowercase hex chars', () => {
		expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff');
	});
});

describe('randomHex', () => {
	it('returns the requested byte count as hex and varies', () => {
		const a = randomHex(32);
		const b = randomHex(32);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).not.toBe(b);
	});
});

describe('constantTimeEqualHex', () => {
	it('is true for equal strings, false for differing or unequal-length ones', () => {
		expect(constantTimeEqualHex('abcd', 'abcd')).toBe(true);
		expect(constantTimeEqualHex('abcd', 'abce')).toBe(false);
		expect(constantTimeEqualHex('abcd', 'abc')).toBe(false);
	});
});
