// SCITT integration. Two parts, both explicit about the FORMAT-vs-SERVICE boundary:
//   1. A LOCAL Transparency-Service DOUBLE: registers a Signed Statement's hash into an append-only
//      log (`scitt_log`, durable in D1), rebuilds an MMR over all registered hashes, and issues a
//      signed Receipt containing a real inclusion proof. This is a test double, not a production
//      Transparency Service — Facet does not operate a public log.
//   2. A PLUGGABLE EXTERNAL CLIENT: when `SCITT_URL` is configured, POSTs the Signed Statement to an
//      external Transparency Service, then VERIFIES the returned Receipt (signature + inclusion proof)
//      when it is in Facet's SignedStatement form. No-op (returns null) when unset.
// Receipts are issued in the JWS wire form here; @facet/trust also ships the COSE_Sign1 SCITT-native
// form (both workerd-verified — see the trust README).

import {
	type ScittReceiptPayload,
	type ScittReceiptVerification,
	type SignedStatement,
	addLeafHash,
	canonicalDigestHex,
	fromHex,
	inclusionToReceipt,
	leafHash,
	mmrRoot,
	proveInclusion,
	signScittReceipt,
	toHex,
	verifyScittReceipt,
} from '@facet/trust';
import { asc } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { getSigningKey } from './signing.js';

/** Identifier of the local Transparency-Service double's log. */
export const LOCAL_LOG_ID = 'facet-scitt-local' as const;

/** Hex SHA-256 of a Signed Statement's canonical bytes. */
function statementHash(stmt: SignedStatement): Promise<string> {
	return canonicalDigestHex(stmt);
}

/**
 * Register a Signed Statement with the LOCAL Transparency-Service double: record its hash, rebuild the
 * MMR over every registered hash, and return a signed Receipt with an inclusion proof. Requires a
 * deployment signing key (the log operator's key); returns null when signing is unconfigured.
 */
export async function registerLocal(
	env: Env,
	stmt: SignedStatement,
	now: number,
	format: 'jws' | 'cose' = 'jws',
): Promise<SignedStatement<ScittReceiptPayload> | null> {
	const loading = getSigningKey(env);
	if (!loading) return null;
	const key = await loading;
	const client = db(env);

	const hash = await statementHash(stmt);
	// Capture OUR row's autoincrement id so we can locate our own leaf even if a concurrent registration
	// inserts between this write and the read below — a row-count assumption would point at the wrong leaf.
	const [inserted] = await client
		.insert(schema.scittLog)
		.values({ statementHash: hash, registeredAt: now })
		.returning({ entryId: schema.scittLog.entryId });
	if (!inserted) return null;

	const rows = await client
		.select({
			entryId: schema.scittLog.entryId,
			hash: schema.scittLog.statementHash,
		})
		.from(schema.scittLog)
		.orderBy(asc(schema.scittLog.entryId));

	// Rebuild the MMR over all registered statement hashes; our leaf is the one whose row id we captured.
	const nodes: Uint8Array[] = [];
	const leafNodeIndices: number[] = [];
	for (const row of rows) {
		leafNodeIndices.push(await addLeafHash(nodes, await leafHash(fromHex(row.hash))));
	}
	const entryId = rows.findIndex((r) => r.entryId === inserted.entryId);
	if (entryId < 0) return null;
	const size = nodes.length;
	const root = toHex(await mmrRoot(nodes));
	const inclusion = inclusionToReceipt(
		proveInclusion(nodes, leafNodeIndices[entryId] as number, size),
	);

	const payload: ScittReceiptPayload = {
		logId: LOCAL_LOG_ID,
		entryId,
		statementHash: hash,
		treeSize: size,
		root,
		inclusion,
		registeredAt: new Date(now).toISOString(),
	};
	return signScittReceipt(payload, key, now, format);
}

/** Result of an external SCITT registration: the raw receipt the service returned, plus — when that
 * receipt is in Facet's SignedStatement form — the outcome of verifying its signature + inclusion. */
export interface ExternalRegistration {
	receipt: unknown;
	/** Verification of the returned receipt, or null when it is not a Facet-format SignedStatement. */
	verification: ScittReceiptVerification | null;
	/** Whether the returned receipt actually attests OUR submitted statement (its `statementHash` equals
	 * the hash we POSTed). A receipt that verifies internally but is about a different statement proves
	 * nothing about this deployment, so consumers MUST require `statementMatches && verification.valid`. */
	statementMatches: boolean;
}

/** True when a value looks like a Facet SignedStatement receipt (has a proof + an inclusion payload). */
function isReceiptShape(v: unknown): v is SignedStatement<ScittReceiptPayload> {
	if (!v || typeof v !== 'object') return false;
	const o = v as { proof?: unknown; payload?: { inclusion?: unknown } };
	return typeof o.proof === 'object' && typeof o.payload?.inclusion === 'object';
}

/**
 * Register a Signed Statement with an EXTERNAL SCITT Transparency Service, if `SCITT_URL` is set.
 * Returns the service's Receipt AND — when the receipt is in Facet's SignedStatement form — the result
 * of verifying its signature + MMR inclusion proof. Returns null when no external service is configured.
 * This is the documented integration point; Facet does not operate the external service.
 */
export async function registerExternal(
	env: Env,
	stmt: SignedStatement,
): Promise<ExternalRegistration | null> {
	if (!env.SCITT_URL) return null;
	const res = await fetch(env.SCITT_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(env.SCITT_TOKEN ? { authorization: `Bearer ${env.SCITT_TOKEN}` } : {}),
		},
		body: JSON.stringify(stmt),
	});
	if (!res.ok) throw new Error(`external SCITT registration failed: ${res.status}`);
	const receipt = await res.json();
	if (!isReceiptShape(receipt)) {
		return { receipt, verification: null, statementMatches: false };
	}
	const verification = await verifyScittReceipt(receipt);
	// Bind the receipt to what we actually submitted: an internally-valid receipt over a DIFFERENT
	// statement proves nothing about this deployment.
	const statementMatches = receipt.payload.statementHash === (await statementHash(stmt));
	return { receipt, verification, statementMatches };
}
