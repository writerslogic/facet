// The receipt verify wrappers must fail closed: a malformed hex/numeric field returns false, never a
// thrown exception, regardless of caller error handling. (fromHex now rejects non-hex, so the wrappers
// have to contain that throw themselves — receipt fields arrive as untrusted JSON from a SCITT peer.)

import { describe, expect, it } from 'vitest';
import { type InclusionReceipt, verifyInclusionReceipt } from '../src/receipt.js';

describe('receipt verify fails closed', () => {
	const wellFormed = (over: Partial<InclusionReceipt> = {}): InclusionReceipt => ({
		index: 0,
		leaf: '00'.repeat(32),
		path: [],
		size: 1,
		peaks: ['00'.repeat(32)],
		...over,
	});

	it('returns false (not a throw) on a non-hex leaf', async () => {
		await expect(
			verifyInclusionReceipt(wellFormed({ leaf: 'zz' }), '00'.repeat(32)),
		).resolves.toBe(false);
	});

	it('returns false (not a throw) on a non-hex root', async () => {
		await expect(verifyInclusionReceipt(wellFormed(), 'not-hex')).resolves.toBe(false);
	});

	it('returns false on a wrong-but-well-formed root rather than accepting it', async () => {
		await expect(verifyInclusionReceipt(wellFormed(), 'ab'.repeat(32))).resolves.toBe(false);
	});
});
