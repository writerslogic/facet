// D1-backed Merkle Mountain Range transparency log over finalized event_rollups. On the hourly cron
// (only when a signing key is configured) it appends a leaf per newly-finalized rollup and emits a
// signed checkpoint. Leaves commit the aggregate rollup row (JCS bytes) — never raw events or PII.
// This is the log maintained inside Facet; operating a production transparency SERVICE is a separate
// deployment concern (see SCITT, P4.9). Every operation goes through a batched `NodeStore` and reads
// only the O(log n) nodes it needs (peaks for append/root, the sibling path for proofs) — the tree is
// never loaded whole.

import {
	type Checkpoint,
	type ConsistencyReceipt,
	type InclusionReceipt,
	type NodeStore,
	type SignedStatement,
	type SigningKey,
	appendLeaves,
	canonicalizeBytes,
	consistencyToReceipt,
	fromHex,
	inclusionToReceipt,
	leafHash,
	mmrRootStore,
	proveConsistencyStore,
	proveInclusionStore,
	signCheckpoint,
	toHex,
} from '@facet/trust';
import { and, asc, count, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { D1_MAX_IN_PARAMS, HOUR_MS, chunked } from './constants.js';
import { getSigningKey } from './signing.js';

/** D1 caps a statement at 100 bound parameters. A node row binds 2 and a leaf row binds 4, so each
 * insert is chunked from its own arity — one shared constant would silently overrun the leaf insert. */
const NODE_INSERT_CHUNK = 45;
const LEAF_INSERT_CHUNK = 22;

/** Leaves appended per tick. The first tick after a signing key is configured faces every rollup ever
 * written; the candidate query's ordering makes the prefix deterministic, so later ticks drain the
 * remainder rather than this one pulling the table into the isolate and overrunning the batch. */
const APPEND_LIMIT = 250;

/** Stable identity of a rollup row (used to dedupe log appends and to look up an inclusion proof). */
export function rollupKey(r: {
	siteId: string;
	hostname: string;
	bucketStart: number;
	interval: string;
}): string {
	return `${r.siteId}|${r.hostname}|${r.bucketStart}|${r.interval}`;
}

/** The canonical leaf value for a rollup row (JCS over the aggregate fields, never raw events). */
function rollupLeafBytes(r: {
	siteId: string;
	hostname: string;
	bucketStart: number;
	interval: string;
	pageviews: number;
	events: number;
	visitors: number;
}): Uint8Array {
	return canonicalizeBytes({
		site_id: r.siteId,
		hostname: r.hostname,
		bucket_start: r.bucketStart,
		interval: r.interval,
		pageviews: r.pageviews,
		events: r.events,
		visitors: r.visitors,
	});
}

/** A batched {@link NodeStore} over the `mmr_nodes` table — one `WHERE node_index IN (…)` per read. */
function d1NodeStore(env: Env): NodeStore {
	return {
		async getMany(indices) {
			if (indices.length === 0) return [];
			const unique = [...new Set(indices)];
			const byIndex = new Map<number, Uint8Array>();
			// A consistency proof reads O(log²n) nodes (a sibling path per old peak), so past a few
			// thousand leaves that IN(…) list alone exceeds D1's bound-parameter cap — and
			// `/api/transparency/consistency` is public.
			for (const chunk of chunked(unique, D1_MAX_IN_PARAMS)) {
				const rows = await db(env)
					.select({
						index: schema.mmrNodes.nodeIndex,
						hash: schema.mmrNodes.hash,
					})
					.from(schema.mmrNodes)
					.where(inArray(schema.mmrNodes.nodeIndex, chunk));
				for (const r of rows) byIndex.set(r.index, fromHex(r.hash));
			}
			return indices.map((i) => {
				const hash = byIndex.get(i);
				// IMPORTANT: a missing row means the persisted tree is incomplete; fail here rather
				// than folding `undefined` into the hash a receipt gets signed over.
				if (!hash) throw new Error(`transparency: missing MMR node ${i}`);
				return hash;
			});
		},
	};
}

/** The current MMR node count (the tree size), without loading any node. */
async function nodeCount(env: Env): Promise<number> {
	const [row] = await db(env).select({ n: count() }).from(schema.mmrNodes);
	return row?.n ?? 0;
}

/** The current count of logged leaves, without loading any leaf row. */
async function mmrLeafCount(env: Env): Promise<number> {
	const [row] = await db(env).select({ n: count() }).from(schema.mmrLeaves);
	return row?.n ?? 0;
}

/** The same composite key `rollupKey()` builds, as a SQL expression over `event_rollups` columns —
 * matched against `mmr_leaves.rollup_key` (unique-indexed) to anti-join already-logged rows without
 * ever reading them. Separator and field order MUST stay in lockstep with `rollupKey()`. */
const rollupKeyExpr = sql`${schema.eventRollups.siteId} || '|' || ${schema.eventRollups.hostname} || '|' || ${schema.eventRollups.bucketStart} || '|' || ${schema.eventRollups.interval}`;

/** Append every finalized, not-yet-logged rollup as a leaf. Returns the number appended. */
export async function appendFinalizedRollups(env: Env, now: number): Promise<number> {
	const client = db(env);
	// A rollup is finalized once its bucket has fully elapsed (bucket end <= the current hour floor).
	// FIXME: routes/import.ts re-runs rollupBucket over arbitrary historical days and rollups.ts
	// overwrites the counters absolutely, so an elapsed bucket is not in fact immutable. A rewritten
	// rollup cannot be re-leafed while mmr_leaves.rollup_key is unique, so the fix is not in this file.
	const hourFloor = Math.floor(now / HOUR_MS) * HOUR_MS;
	// event_rollups is never pruned (rollups.ts keeps every bucket forever) and mmr_leaves grows in
	// lockstep with what's already logged, so both filters run in SQL — an unbounded hourly cron tick
	// must never pull either table whole into the isolate.
	const candidates = await client
		.select({
			siteId: schema.eventRollups.siteId,
			hostname: schema.eventRollups.hostname,
			bucketStart: schema.eventRollups.bucketStart,
			interval: schema.eventRollups.interval,
			pageviews: schema.eventRollups.pageviews,
			events: schema.eventRollups.events,
			visitors: schema.eventRollups.visitors,
		})
		.from(schema.eventRollups)
		.leftJoin(schema.mmrLeaves, eq(schema.mmrLeaves.rollupKey, rollupKeyExpr))
		.where(
			and(
				isNull(schema.mmrLeaves.rollupKey),
				or(
					and(
						eq(schema.eventRollups.interval, 'day'),
						lte(schema.eventRollups.bucketStart, hourFloor - 24 * HOUR_MS),
					),
					// IMPORTANT: an explicit allowlist, never `interval != 'day'`. `lib/coarsen.ts` writes
					// `month`/`year` rows whose `visitors` is deliberately 0, and an exclusion filter would
					// hash that 0 into a permanent signed leaf, attesting "this month had no visitors".
					and(
						eq(schema.eventRollups.interval, 'hour'),
						lte(schema.eventRollups.bucketStart, hourFloor - HOUR_MS),
					),
				),
			),
		)
		.orderBy(
			asc(schema.eventRollups.bucketStart),
			asc(schema.eventRollups.siteId),
			asc(schema.eventRollups.hostname),
			asc(schema.eventRollups.interval),
		)
		.limit(APPEND_LIMIT);

	const finalized: { key: string; leaf: Uint8Array }[] = [];
	for (const r of candidates) {
		finalized.push({ key: rollupKey(r), leaf: await leafHash(rollupLeafBytes(r)) });
	}
	if (finalized.length === 0) return 0;

	const startCount = await nodeCount(env);
	const appended = await appendLeaves(
		d1NodeStore(env),
		startCount,
		finalized.map((f) => f.leaf),
	);
	const priorLeaves = await mmrLeafCount(env);

	const nodeRows = appended.newNodes.map((n) => ({ nodeIndex: n.index, hash: toHex(n.hash) }));
	const leafRows = finalized.map((f, k) => ({
		leafNo: priorLeaves + k,
		nodeIndex: appended.leafIndices[k] as number,
		rollupKey: f.key,
		leafHash: toHex(f.leaf),
	}));
	// Nodes and leaves must land together. As two separate inserts, a crash in between would leave
	// orphaned nodes — counted by peakIndices but referenced by no leaf — silently corrupting every
	// later root. D1 runs a batch as one atomic transaction, closing that window.
	const stmts = [
		...chunked(nodeRows, NODE_INSERT_CHUNK).map((c) =>
			client.insert(schema.mmrNodes).values(c),
		),
		...chunked(leafRows, LEAF_INSERT_CHUNK).map((c) =>
			client.insert(schema.mmrLeaves).values(c),
		),
	];
	await client.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
	return finalized.length;
}

/** Compute the current bagged root + size, reading only the accumulator peaks. */
async function currentRoot(env: Env): Promise<{ size: number; root: string }> {
	const size = await nodeCount(env);
	const root = toHex(await mmrRootStore(d1NodeStore(env), size));
	return { size, root };
}

/** Emit and persist a signed checkpoint over the current tree. Returns the signed checkpoint. */
export async function emitCheckpoint(
	env: Env,
	now: number,
	key: SigningKey,
): Promise<SignedStatement<Checkpoint>> {
	const { size, root } = await currentRoot(env);
	const checkpoint: Checkpoint = {
		profile: 'MMR_SHA256',
		size,
		root,
		timestamp: new Date(now).toISOString(),
	};
	const signed = await signCheckpoint(checkpoint, key, now);
	await db(env)
		.insert(schema.mmrCheckpoints)
		.values({
			treeSize: size,
			root,
			createdAt: now,
			signed: JSON.stringify(signed),
		});
	return signed;
}

/** The latest signed checkpoint, or null when none has been emitted. Reads one row (newest id), not
 * the whole checkpoint history — each row carries a full signed-checkpoint JSON blob. */
export async function latestCheckpoint(env: Env): Promise<SignedStatement<Checkpoint> | null> {
	const [last] = await db(env)
		.select({ signed: schema.mmrCheckpoints.signed })
		.from(schema.mmrCheckpoints)
		.orderBy(desc(schema.mmrCheckpoints.id))
		.limit(1);
	return last ? (JSON.parse(last.signed) as SignedStatement<Checkpoint>) : null;
}

/** Build an inclusion receipt for a rollup, against the current tree. Null if the rollup is unlogged. */
export async function inclusionForRollup(
	env: Env,
	key: string,
): Promise<{ receipt: InclusionReceipt; root: string; size: number } | null> {
	const leaf = await db(env)
		.select({ nodeIndex: schema.mmrLeaves.nodeIndex })
		.from(schema.mmrLeaves)
		.where(eq(schema.mmrLeaves.rollupKey, key));
	if (leaf[0] === undefined) return null;
	const store = d1NodeStore(env);
	const size = await nodeCount(env);
	const proof = await proveInclusionStore(store, leaf[0].nodeIndex, size);
	const root = toHex(await mmrRootStore(store, size));
	return { receipt: inclusionToReceipt(proof), root, size };
}

/** Build a consistency receipt between two tree sizes. */
export async function consistencyBetween(
	env: Env,
	sizeFrom: number,
	sizeTo: number,
): Promise<ConsistencyReceipt> {
	return consistencyToReceipt(await proveConsistencyStore(d1NodeStore(env), sizeFrom, sizeTo));
}

/** Cron entry: maintain the transparency log + emit a checkpoint. No-op unless a signing key is set
 * (the log is part of the opt-in trust layer, like the anomaly webhook). */
export async function runTransparency(env: Env, now: number): Promise<void> {
	const loading = getSigningKey(env);
	if (!loading) return;
	const key = await loading;
	await appendFinalizedRollups(env, now);
	await emitCheckpoint(env, now, key);
}
