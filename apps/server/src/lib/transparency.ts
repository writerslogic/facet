// D1-backed Merkle Mountain Range transparency log over finalized event_rollups. On the hourly cron
// (only when a signing key is configured) it appends a leaf per newly-finalized rollup and emits a
// signed checkpoint. Leaves commit the aggregate rollup row (JCS bytes) — never raw events or PII.
// This is the log maintained inside Facet; operating a production transparency SERVICE is a separate
// deployment concern (see SCITT, P4.9). Node loading is O(tree) for simplicity — a documented test
// double, not a scale-optimized ledger.

import {
	type Checkpoint,
	type ConsistencyReceipt,
	type InclusionReceipt,
	type SignedStatement,
	type SigningKey,
	accumulatorHashes,
	addLeafHash,
	baggedRoot,
	canonicalizeBytes,
	consistencyToReceipt,
	fromHex,
	inclusionToReceipt,
	leafHash,
	proveConsistency,
	proveInclusion,
	signCheckpoint,
	toHex,
} from '@facet/trust';
import { asc, eq } from 'drizzle-orm';
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

/** Load the full MMR node array (hex → bytes), ordered by index. */
async function loadNodes(env: Env): Promise<Uint8Array[]> {
	const rows = await db(env)
		.select({ hash: schema.mmrNodes.hash })
		.from(schema.mmrNodes)
		.orderBy(asc(schema.mmrNodes.nodeIndex));
	return rows.map((row) => fromHex(row.hash));
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

	const nodes = await loadNodes(env);
	const startCount = nodes.length;
	let leafNo = (await client.select({ k: schema.mmrLeaves.leafNo }).from(schema.mmrLeaves))
		.length;
	const newLeaves: (typeof schema.mmrLeaves.$inferInsert)[] = [];

	for (const r of rollups) {
		const intervalMs = r.interval === 'day' ? 24 * HOUR_MS : HOUR_MS;
		if (r.bucketStart + intervalMs > hourFloor) continue; // not finalized yet
		const key = rollupKey(r);
		if (logged.has(key)) continue;
		const leaf = await leafHash(rollupLeafBytes(r));
		const nodeIndex = await addLeafHash(nodes, leaf);
		newLeaves.push({
			leafNo: leafNo++,
			nodeIndex,
			rollupKey: key,
			leafHash: toHex(leaf),
		});
	}

	if (nodes.length > startCount) {
		const nodeRows = [];
		for (let i = startCount; i < nodes.length; i++) {
			nodeRows.push({
				nodeIndex: i,
				hash: toHex(nodes[i] as Uint8Array),
			});
		}
		await client.insert(schema.mmrNodes).values(nodeRows);
	}
	if (newLeaves.length > 0) {
		await client.insert(schema.mmrLeaves).values(newLeaves);
	}
	return newLeaves.length;
}

/** Compute the current bagged root + size from the persisted nodes. */
async function currentRoot(env: Env): Promise<{ size: number; root: string }> {
	const nodes = await loadNodes(env);
	const size = nodes.length;
	const root = toHex(await baggedRoot(size, accumulatorHashes(nodes, size)));
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

/** The latest signed checkpoint, or null when none has been emitted. */
export async function latestCheckpoint(env: Env): Promise<SignedStatement<Checkpoint> | null> {
	const rows = await db(env)
		.select()
		.from(schema.mmrCheckpoints)
		.orderBy(asc(schema.mmrCheckpoints.id));
	const last = rows[rows.length - 1];
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
	const nodes = await loadNodes(env);
	const size = nodes.length;
	const proof = proveInclusion(nodes, leaf[0].nodeIndex, size);
	const root = toHex(await baggedRoot(size, accumulatorHashes(nodes, size)));
	return { receipt: inclusionToReceipt(proof), root, size };
}

/** Build a consistency receipt between two tree sizes. */
export async function consistencyBetween(
	env: Env,
	sizeFrom: number,
	sizeTo: number,
): Promise<ConsistencyReceipt> {
	const nodes = await loadNodes(env);
	return consistencyToReceipt(proveConsistency(nodes, sizeFrom, sizeTo));
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
