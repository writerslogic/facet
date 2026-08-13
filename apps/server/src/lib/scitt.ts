// SCITT integration. Two parts, both explicit about the FORMAT-vs-SERVICE boundary:
//   1. A LOCAL Transparency-Service DOUBLE: registers a Signed Statement's hash into an append-only
//      log (`scitt_log`, durable in D1), maintains an MMR over registered hashes incrementally (see
//      `scitt_mmr_nodes`/`scitt_mmr_leaves`, mirroring the rollup transparency log in
//      `lib/transparency.ts`), and issues a signed Receipt containing a real inclusion proof. This is
//      a test double, not a production Transparency Service — Facet does not operate a public log.
//   2. A PLUGGABLE EXTERNAL CLIENT: when `SCITT_URL` is configured, POSTs the Signed Statement to an
//      external Transparency Service, then VERIFIES the returned Receipt (signature + inclusion proof)
//      when it is in Facet's SignedStatement form. No-op (returns null) when unset.
// Receipts are issued in the JWS wire form here; @facet/trust also ships the COSE_Sign1 SCITT-native
// form (both workerd-verified — see the trust README).

import {
	type NodeStore,
	type ScittReceiptPayload,
	type ScittReceiptVerification,
	type SignedStatement,
	addLeafHash,
	appendLeaves,
	canonicalDigestHex,
	fromHex,
	inclusionToReceipt,
	leafHash,
	mmrRootStore,
	proveInclusionStore,
	signScittReceipt,
	toHex,
	verifyScittReceipt,
} from '@facet/trust';
import { asc, count, inArray } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { chunked } from './constants.js';
import { getSigningKey } from './signing.js';

/** Identifier of the local Transparency-Service double's log. */
export const LOCAL_LOG_ID = 'facet-scitt-local' as const;

/** Bound attempts against a concurrent registration racing the same node/leaf slot (see
 * `attemptRegisterLocal`). This endpoint is admin-only, so sustained contention is not expected — the
 * bound exists to fail loudly rather than loop, not because 5 is a tuned figure. */
const MAX_REGISTER_ATTEMPTS = 5;

/** D1 caps a statement at 100 bound parameters; each node/leaf row binds 2, so chunk row inserts at
 * half `D1_MAX_IN_PARAMS`'s already-conservative margin. Only the one-time backfill in
 * `seedScittMmr` can produce enough rows to need this — a single registration's new nodes never do. */
const MMR_INSERT_CHUNK = 45;

/** Hex SHA-256 of a Signed Statement's canonical bytes. */
function statementHash(stmt: SignedStatement): Promise<string> {
	return canonicalDigestHex(stmt);
}

/** A batched {@link NodeStore} over `scitt_mmr_nodes`. */
function scittNodeStore(env: Env): NodeStore {
	return {
		async getMany(indices) {
			if (indices.length === 0) return [];
			const unique = [...new Set(indices)];
			const rows = await db(env)
				.select({ index: schema.scittMmrNodes.nodeIndex, hash: schema.scittMmrNodes.hash })
				.from(schema.scittMmrNodes)
				.where(inArray(schema.scittMmrNodes.nodeIndex, unique));
			const byIndex = new Map(rows.map((r) => [r.index, fromHex(r.hash)]));
			return indices.map((i) => byIndex.get(i) as Uint8Array);
		},
	};
}

async function scittNodeCount(env: Env): Promise<number> {
	const [row] = await db(env).select({ n: count() }).from(schema.scittMmrNodes);
	return row?.n ?? 0;
}

async function scittLeafCount(env: Env): Promise<number> {
	const [row] = await db(env).select({ n: count() }).from(schema.scittMmrLeaves);
	return row?.n ?? 0;
}

async function scittLogCount(env: Env): Promise<number> {
	const [row] = await db(env).select({ n: count() }).from(schema.scittLog);
	return row?.n ?? 0;
}

/**
 * Backfill `scitt_mmr_nodes`/`scitt_mmr_leaves` from `scitt_log`'s full history, when the persisted
 * MMR state is behind it — true for a deployment that registered statements before this incremental
 * persistence existed. A no-op once caught up (including the always-empty case), because every
 * registration from here on keeps `scitt_log` and the MMR tables in lockstep in one atomic batch.
 */
async function seedScittMmr(env: Env): Promise<void> {
	const client = db(env);
	// PERF: cheap COUNT(*) catch-up check first — this runs on every registration attempt (up to
	// MAX_REGISTER_ATTEMPTS times under contention), and the common case (already caught up) never
	// needs the rows themselves, only whether backfill is needed at all.
	const [logCount, leafCount] = await Promise.all([scittLogCount(env), scittLeafCount(env)]);
	if (leafCount >= logCount) return;

	const rows = await client
		.select({ hash: schema.scittLog.statementHash })
		.from(schema.scittLog)
		.orderBy(asc(schema.scittLog.entryId));

	const nodes: Uint8Array[] = [];
	const leafIndices: number[] = [];
	for (const row of rows) {
		leafIndices.push(await addLeafHash(nodes, await leafHash(fromHex(row.hash))));
	}
	const nodeRows = nodes.map((hash, nodeIndex) => ({ nodeIndex, hash: toHex(hash) }));
	const leafRows = leafIndices.map((nodeIndex, leafNo) => ({ leafNo, nodeIndex }));
	const stmts = [
		...chunked(nodeRows, MMR_INSERT_CHUNK).map((c) =>
			client.insert(schema.scittMmrNodes).values(c),
		),
		...chunked(leafRows, MMR_INSERT_CHUNK).map((c) =>
			client.insert(schema.scittMmrLeaves).values(c),
		),
	];
	// A concurrent seed racing this one collides on `node_index`/`leaf_no` and rolls the whole batch
	// back (D1 runs `batch` as one transaction) — safe to ignore: the winner already did the work.
	await client
		.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]])
		.catch(() => {});
}

interface RegisterAttempt {
	entryId: number;
	treeSize: number;
	leafIndex: number;
}

/**
 * Append one leaf and persist it. Returns null on a conflict — a concurrent registration claimed the
 * same node/leaf slot first (a stale `startCount`/`entryId` read, now resolved by D1's PK constraint
 * rather than the old array rebuild's "reread and relocate our row" trick) — so the caller can retry
 * from fresh counts. The batch is atomic: a losing attempt leaves nothing half-written.
 */
async function attemptRegisterLocal(
	env: Env,
	hash: string,
	now: number,
): Promise<RegisterAttempt | null> {
	await seedScittMmr(env);
	const client = db(env);
	const store = scittNodeStore(env);
	const [startCount, entryId] = await Promise.all([scittNodeCount(env), scittLeafCount(env)]);
	const leaf = await leafHash(fromHex(hash));
	const appended = await appendLeaves(store, startCount, [leaf]);
	const leafIndex = appended.leafIndices[0] as number;
	const nodeRows = appended.newNodes.map((n) => ({ nodeIndex: n.index, hash: toHex(n.hash) }));
	const stmts = [
		client.insert(schema.scittLog).values({ statementHash: hash, registeredAt: now }),
		...chunked(nodeRows, MMR_INSERT_CHUNK).map((c) =>
			client.insert(schema.scittMmrNodes).values(c),
		),
		client.insert(schema.scittMmrLeaves).values({ leafNo: entryId, nodeIndex: leafIndex }),
	];
	try {
		await client.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
	} catch {
		return null;
	}
	return { entryId, treeSize: appended.count, leafIndex };
}

/**
 * Register a Signed Statement with the LOCAL Transparency-Service double: record its hash, extend the
 * MMR incrementally (reading/writing only the nodes this append touches, not the whole tree), and
 * return a signed Receipt with an inclusion proof. Requires a deployment signing key (the log
 * operator's key); returns null when signing is unconfigured.
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
	const hash = await statementHash(stmt);

	let attempt: RegisterAttempt | null = null;
	for (let i = 0; i < MAX_REGISTER_ATTEMPTS && !attempt; i++) {
		attempt = await attemptRegisterLocal(env, hash, now);
	}
	if (!attempt) {
		throw new Error('scitt: could not register after repeated concurrent contention');
	}

	const store = scittNodeStore(env);
	const root = toHex(await mmrRootStore(store, attempt.treeSize));
	const inclusion = inclusionToReceipt(
		await proveInclusionStore(store, attempt.leafIndex, attempt.treeSize),
	);

	const payload: ScittReceiptPayload = {
		logId: LOCAL_LOG_ID,
		entryId: attempt.entryId,
		statementHash: hash,
		treeSize: attempt.treeSize,
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
