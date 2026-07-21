// Merkle Mountain Range (append-only log), profiled against draft-bryce-cose-receipts-mmr-profile
// (MMR_SHA256): a linearly-addressed, position-committing MMR. Interior nodes are
// `H(pos_be64 || left || right)` with `pos = index + 1` (one-based), binding each node to its
// location; leaves are `H(x)`. Node indices are permanent, so inclusion paths are stable. This is the
// pure, storage-agnostic core (an array of 32-byte node hashes); the server persists nodes in D1.
// Covers a DATASET (aggregate rollups), never a person.

import { bytesEqual, sha256, utf8 } from './bytes.js';

/** A one-based node position as an unsigned 64-bit big-endian byte string. */
function u64be(n: number): Uint8Array {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
	return out;
}

/** `H(pos_be64 || left || right)` — the position-committing interior-node hash. */
export function hashPosPair(pos: number, left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
	return sha256(u64be(pos), left, right);
}

/** Leaf hash `H(x)` for a caller-defined leaf value. */
export function leafHash(x: Uint8Array | string): Promise<Uint8Array> {
	return sha256(typeof x === 'string' ? utf8(x) : x);
}

/** True when every bit of `n` up to its top set bit is 1 (i.e. n = 2^k - 1). */
function allOnes(n: number): boolean {
	return (n & (n + 1)) === 0 && n !== 0;
}

/** The value of the most significant set bit of `n`. */
function mostSigBit(n: number): number {
	return 1 << (31 - Math.clz32(n));
}

/** Zero-based height `g` of the node at index `i` (draft `index_height`). */
export function indexHeight(i: number): number {
	let pos = i + 1;
	while (!allOnes(pos)) {
		pos = pos - mostSigBit(pos) + 1;
	}
	return (31 - Math.clz32(pos)) as number;
}

/** Peak indices (the accumulator) for MMR with `count` nodes (draft `peaks`). */
export function peakIndices(count: number): number[] {
	let peak = 0;
	const out: number[] = [];
	let s = count;
	while (s !== 0) {
		const highest = (1 << Math.floor(Math.log2(s + 1))) - 1;
		peak += highest;
		out.push(peak - 1);
		s -= highest;
	}
	return out;
}

/** Append leaf hash `f` to `nodes` (in place), merging equal-height peaks. Returns the leaf's index. */
export async function addLeafHash(nodes: Uint8Array[], f: Uint8Array): Promise<number> {
	let g = 0;
	nodes.push(f);
	const leafIndex = nodes.length - 1;
	let i = nodes.length; // index of the next free slot (= draft's post-append length)
	while (indexHeight(i) > g) {
		const ileft = i - (2 << g);
		const iright = i - 1;
		const left = nodes[ileft] as Uint8Array;
		const right = nodes[iright] as Uint8Array;
		nodes.push(await hashPosPair(i + 1, left, right));
		i = nodes.length;
		g += 1;
	}
	return leafIndex;
}

/** Sibling indices proving inclusion of node `i` within a tree whose last index is `c` (draft path). */
export function inclusionProofPath(i: number, c: number): number[] {
	const path: number[] = [];
	let g = indexHeight(i);
	let idx = i;
	while (true) {
		const siblingOffset = 2 << g;
		let isibling: number;
		if (indexHeight(idx + 1) > g) {
			isibling = idx - siblingOffset + 1;
			idx += 1;
		} else {
			isibling = idx + siblingOffset - 1;
			idx += siblingOffset;
		}
		if (isibling > c) return path;
		path.push(isibling);
		g += 1;
	}
}

/** Fold an inclusion `proof` (sibling hashes) from node `i`/`nodeHash` up to its accumulator peak. */
export async function includedRoot(
	i: number,
	nodeHash: Uint8Array,
	proof: Uint8Array[],
): Promise<Uint8Array> {
	let root = nodeHash;
	let g = indexHeight(i);
	let idx = i;
	for (const sibling of proof) {
		if (indexHeight(idx + 1) > g) {
			idx += 1;
			root = await hashPosPair(idx + 1, sibling, root);
		} else {
			idx += 2 << g;
			root = await hashPosPair(idx + 1, root, sibling);
		}
		g += 1;
	}
	return root;
}

/** Bag the accumulator peaks into a single root commitment: `H(count_be64 || peak0 || peak1 || …)`. */
export async function baggedRoot(count: number, peaks: Uint8Array[]): Promise<Uint8Array> {
	return sha256(u64be(count), ...peaks);
}

/** The accumulator (peak hashes) for a tree of `count` nodes. */
export function accumulatorHashes(nodes: Uint8Array[], count: number): Uint8Array[] {
	return peakIndices(count).map((i) => nodes[i] as Uint8Array);
}

/** The bagged root over the full node array — `baggedRoot(nodes.length, accumulator)`. The single
 * "compute the current tree root" helper, so callers never re-spell the accumulator+bag composition. */
export function mmrRoot(nodes: Uint8Array[]): Promise<Uint8Array> {
	return baggedRoot(nodes.length, accumulatorHashes(nodes, nodes.length));
}

/** An inclusion proof: the leaf's node index, its hash, the sibling path, and the committed tree. */
export interface InclusionProof {
	index: number;
	leaf: Uint8Array;
	path: Uint8Array[];
	size: number;
	peaks: Uint8Array[];
}

/** Produce an inclusion proof for the node at `index` against the tree of `count` nodes. */
export function proveInclusion(nodes: Uint8Array[], index: number, count: number): InclusionProof {
	const path = inclusionProofPath(index, count - 1).map((s) => nodes[s] as Uint8Array);
	return {
		index,
		leaf: nodes[index] as Uint8Array,
		path,
		size: count,
		peaks: accumulatorHashes(nodes, count),
	};
}

/** Verify an inclusion proof against a signed bagged `root`: the node folds to an accumulator peak,
 * and the accumulator bags to `root`. */
export async function verifyInclusion(proof: InclusionProof, root: Uint8Array): Promise<boolean> {
	// An inclusion receipt proves membership of a LEAF; reject interior (aggregation) nodes, else an
	// internal node hash would verify as a committed log entry.
	if (indexHeight(proof.index) !== 0) return false;
	const peak = await includedRoot(proof.index, proof.leaf, proof.path);
	if (!proof.peaks.some((p) => bytesEqual(p, peak))) return false;
	return bytesEqual(await baggedRoot(proof.size, proof.peaks), root);
}

/** A consistency proof: inclusion proofs, in the larger tree, for each peak of the smaller tree. */
export interface ConsistencyProof {
	sizeFrom: number;
	sizeTo: number;
	peaksFrom: Uint8Array[];
	/** For each peak of the `sizeFrom` accumulator: its node index and sibling path in the larger tree. */
	inclusions: { index: number; leaf: Uint8Array; path: Uint8Array[] }[];
	peaksTo: Uint8Array[];
}

/** Prove that the tree at `sizeFrom` is a prefix of the tree at `sizeTo` (`sizeFrom <= sizeTo`). */
export function proveConsistency(
	nodes: Uint8Array[],
	sizeFrom: number,
	sizeTo: number,
): ConsistencyProof {
	const peaksFromIdx = peakIndices(sizeFrom);
	return {
		sizeFrom,
		sizeTo,
		peaksFrom: peaksFromIdx.map((i) => nodes[i] as Uint8Array),
		inclusions: peaksFromIdx.map((index) => ({
			index,
			leaf: nodes[index] as Uint8Array,
			path: inclusionProofPath(index, sizeTo - 1).map((s) => nodes[s] as Uint8Array),
		})),
		peaksTo: accumulatorHashes(nodes, sizeTo),
	};
}

/** Verify a consistency proof against both signed roots. */
export async function verifyConsistency(
	proof: ConsistencyProof,
	rootFrom: Uint8Array,
	rootTo: Uint8Array,
): Promise<boolean> {
	// The larger tree cannot be smaller, and there must be exactly one inclusion per old peak.
	if (proof.sizeTo < proof.sizeFrom) return false;
	if (proof.inclusions.length !== proof.peaksFrom.length) return false;
	// The old accumulator must bag to the old signed root.
	if (!bytesEqual(await baggedRoot(proof.sizeFrom, proof.peaksFrom), rootFrom)) return false;
	// The new accumulator must bag to the new signed root.
	if (!bytesEqual(await baggedRoot(proof.sizeTo, proof.peaksTo), rootTo)) return false;
	// Each OLD PEAK must itself be the leaf of its inclusion proof AND fold to a new accumulator peak.
	// Binding inc.leaf to peaksFrom[i] is what actually proves the old tree is a prefix of the new one;
	// without it a prover could supply inclusions for unrelated nodes and forge a consistency proof.
	for (let i = 0; i < proof.inclusions.length; i++) {
		const inc = proof.inclusions[i] as ConsistencyProof['inclusions'][number];
		if (!bytesEqual(inc.leaf, proof.peaksFrom[i] as Uint8Array)) return false;
		const peak = await includedRoot(inc.index, inc.leaf, inc.path);
		if (!proof.peaksTo.some((p) => bytesEqual(p, peak))) return false;
	}
	return true;
}
