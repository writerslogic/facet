// Signed statements + MMR checkpoints: sign/verify round-trip, tamper detection, and statement-type
// enforcement. Backs the transparency checkpoints and SCITT statements.

import { describe, expect, it } from 'vitest';
import { type Checkpoint, signCheckpoint, verifyCheckpoint } from '../src/checkpoint.js';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';
import { signStatement, verifyStatement } from '../src/statement.js';

async function edKey() {
	const { privateJwk } = await generateSigningJwk('EdDSA');
	return loadSigningKey(JSON.stringify(privateJwk));
}

describe('signed statements', () => {
	it('signs and verifies a typed statement', async () => {
		const key = await edKey();
		const stmt = await signStatement('facet-test/1', { a: 1, b: [2, 3] }, key, 0);
		expect((await verifyStatement(stmt, 'facet-test/1')).valid).toBe(true);
	});

	it('rejects an unexpected statement type', async () => {
		const key = await edKey();
		const stmt = await signStatement('facet-test/1', { a: 1 }, key, 0);
		const res = await verifyStatement(stmt, 'other/1');
		expect(res.valid).toBe(false);
		expect(res.reason).toContain('expected statement type');
	});

	it('fails when the payload is tampered', async () => {
		const key = await edKey();
		const stmt = await signStatement('facet-test/1', { total: 100 }, key, 0);
		(stmt.payload as { total: number }).total = 999;
		expect((await verifyStatement(stmt)).valid).toBe(false);
	});
});

describe('MMR checkpoints', () => {
	const checkpoint: Checkpoint = {
		profile: 'MMR_SHA256',
		size: 42,
		root: 'a'.repeat(64),
		timestamp: '2026-07-01T00:00:00.000Z',
	};

	it('signs and verifies a checkpoint', async () => {
		const key = await edKey();
		const signed = await signCheckpoint(checkpoint, key, 0);
		expect(signed.statement).toBe('facet-mmr-checkpoint/1');
		expect((await verifyCheckpoint(signed)).valid).toBe(true);
	});

	it('fails when the root is tampered', async () => {
		const key = await edKey();
		const signed = await signCheckpoint(checkpoint, key, 0);
		signed.payload.root = 'b'.repeat(64);
		expect((await verifyCheckpoint(signed)).valid).toBe(false);
	});
});
