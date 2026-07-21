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
import { asc, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { HOUR_MS } from './constants.js';
import { getSigningKey } from './signing.js';

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
			const rows = await db(env)
				.select({
					index: schema.mmrNodes.nodeIndex,
					hash: schema.mmrNodes.hash,
				})
				.from(schema.mmrNodes)
				.where(inArray(schema.mmrNodes.nodeIndex, unique));
			const byIndex = new Map(rows.map((r) => [r.index, fromHex(r.hash)]));
			return indices.map((i) => byIndex.get(i) as Uint8Array);
		},
	};
}

/** The current MMR node count (the tree size), without loading any node. */
async function nodeCount(env: Env): Promise<number> {
	const [row] = await db(env).select({ n: count() }).from(schema.mmrNodes);
	return row?.n ?? 0;
}

/** Append every finalized, not-yet-logged rollup as a leaf. Returns the number appended. */
export async function appendFinalizedRollups(env: Env, now: number): Promise<number> {
	const client = db(env);
	// A rollup is finalized once its bucket has fully elapsed (bucket end <= the current hour floor).
	const hourFloor = Math.floor(now / HOUR_MS) * HOUR_MS;
	const rollups = await client
		.select()
		.from(schema.eventRollups)
		.orderBy(
			asc(schema.eventRollups.bucketStart),
			asc(schema.eventRollups.siteId),
			asc(schema.eventRollups.hostname),
			asc(schema.eventRollups.interval),
		);
	const logged = new Set(
		(await client.select({ k: schema.mmrLeaves.rollupKey }).from(schema.mmrLeaves)).map(
			(r) => r.k,
		),
	);

	const finalized: { key: string; leaf: Uint8Array }[] = [];
	for (const r of rollups) {
		const intervalMs = r.interval === 'day' ? 24 * HOUR_MS : HOUR_MS;
		if (r.bucketStart + intervalMs > hourFloor) continue; // not finalized yet
		const key = rollupKey(r);
		if (logged.has(key)) continue;
		finalized.push({ key, leaf: await leafHash(rollupLeafBytes(r)) });
	}
	if (finalized.length === 0) return 0;

	const startCount = await nodeCount(env);
	const appended = await appendLeaves(
		d1NodeStore(env),
		startCount,
		finalized.map((f) => f.leaf),
	);
	const priorLeaves = (await client.select({ k: schema.mmrLeaves.leafNo }).from(schema.mmrLeaves))
		.length;

	// Nodes and leaves must land together. As two separate inserts, a crash in between would leave
	// orphaned nodes — counted by peakIndices but referenced by no leaf — silently corrupting every
	// later root. D1 runs a batch as one atomic transaction, closing that window.
	await client.batch([
		client.insert(schema.mmrNodes).values(
			appended.newNodes.map((n) => ({
				nodeIndex: n.index,
				hash: toHex(n.hash),
			})),
		),
		client.insert(schema.mmrLeaves).values(
			finalized.map((f, k) => ({
				leafNo: priorLeaves + k,
				nodeIndex: appended.leafIndices[k] as number,
				rollupKey: f.key,
				leafHash: toHex(f.leaf),
			})),
		),
	]);
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
