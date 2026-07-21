// Decode-robustness for the shared hex primitive. fromHex feeds MMR-receipt fields (leaf/path/root);
// a malformed value must be rejected, not silently mapped to valid-but-wrong bytes, so a lenient
// decoder can never turn a garbage receipt into one that compares equal at 0-bytes.

import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../src/bytes.js';

describe('fromHex', () => {
	it('round-trips lowercase hex and accepts uppercase', () => {
		const bytes = new Uint8Array([0x00, 0x0f, 0xa5, 0xff]);
		expect(toHex(bytes)).toBe('000fa5ff');
		expect([...fromHex('000fa5ff')]).toEqual([...bytes]);
		expect([...fromHex('000FA5FF')]).toEqual([...bytes]);
	});

	it('rejects an odd-length string instead of truncating a nibble', () => {
		// The old lenient decoder turned "abc" into [0xab], dropping the trailing "c".
		expect(() => fromHex('abc')).toThrow();
		expect(() => fromHex('0')).toThrow();
	});

	it('rejects non-hex characters instead of mapping them to 0', () => {
		// parseInt('0g',16) yields 0 — the lenient decoder accepted "0g" as [0x00].
		expect(() => fromHex('0g')).toThrow();
		expect(() => fromHex('zz')).toThrow();
		expect(() => fromHex('00 ff')).toThrow();
	});
});
