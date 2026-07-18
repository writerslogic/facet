// SCITT integration. Two parts, both explicit about the FORMAT-vs-SERVICE boundary:
//   1. A LOCAL Transparency-Service DOUBLE: registers a Signed Statement's hash into an append-only
//      log (`scitt_log`), rebuilds an MMR over all registered hashes, and issues a signed Receipt
//      containing an inclusion proof. This is a test double, not a production Transparency Service.
//   2. A PLUGGABLE EXTERNAL CLIENT: when `SCITT_URL` is configured, POSTs the Signed Statement to an
//      external Transparency Service and returns its Receipt. No-op (returns null) when unset.
// The canonical SCITT wire format is COSE_Sign1; here statements/receipts are the JWS equivalents
// (COSE is format-ready but gated on a workerd-verified COSE lib — see the trust README).

import {
	type ScittReceiptPayload,
	type SignedStatement,
	accumulatorHashes,
	addLeafHash,
	baggedRoot,
	canonicalizeBytes,
	fromHex,
	inclusionToReceipt,
	leafHash,
	proveInclusion,
	sha256,
	signStatement,
	toHex,
} from '@facet/trust';
import { asc } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { getSigningKey } from './signing.js';

/** Identifier of the local Transparency-Service double's log. */
export const LOCAL_LOG_ID = 'facet-scitt-local' as const;

/** Hex SHA-256 of a Signed Statement's canonical bytes. */
async function statementHash(stmt: SignedStatement): Promise<string> {
	return toHex(await sha256(canonicalizeBytes(stmt)));
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
): Promise<SignedStatement<ScittReceiptPayload> | null> {
	const loading = getSigningKey(env);
	if (!loading) return null;
	const key = await loading;
	const client = db(env);

	const hash = await statementHash(stmt);
	await client.insert(schema.scittLog).values({ statementHash: hash, registeredAt: now });

	const rows = await client
		.select({ hash: schema.scittLog.statementHash })
		.from(schema.scittLog)
		.orderBy(asc(schema.scittLog.entryId));

	// Rebuild the MMR over all registered statement hashes; the just-registered entry is the last leaf.
	const nodes: Uint8Array[] = [];
	const leafNodeIndices: number[] = [];
	for (const row of rows) {
		leafNodeIndices.push(await addLeafHash(nodes, await leafHash(fromHex(row.hash))));
	}
	const entryId = rows.length - 1;
	const size = nodes.length;
	const root = toHex(await baggedRoot(size, accumulatorHashes(nodes, size)));
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
	return signStatement('scitt-receipt/1', payload, key, now);
}

/**
 * Register a Signed Statement with an EXTERNAL SCITT Transparency Service, if `SCITT_URL` is set.
 * Returns the service's raw Receipt (opaque here) or null when no external service is configured.
 * This is the documented integration point; Facet does not operate the external service.
 */
export async function registerExternal(env: Env, stmt: SignedStatement): Promise<unknown | null> {
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
	return res.json();
}
