// MMR (draft-bryce-cose-receipts-mmr-profile / MMR_SHA256): append N leaves, prove inclusion of each,
// tamper a leaf and watch the proof fail, and prove consistency between two tree states. Runs in
// workerd (SHA-256 via Web Crypto). Also pins index-math helpers to the draft's reference values.

import { describe, expect, it } from 'vitest';
import {
	type InclusionProof,
	type NodeStore,
	accumulatorHashes,
	addLeafHash,
	appendLeaves,
	arrayStore,
	baggedRoot,
	indexHeight,
	leafHash,
	mmrRoot,
	mmrRootStore,
	peakIndices,
	proveConsistency,
	proveConsistencyStore,
	proveInclusion,
	proveInclusionStore,
	verifyConsistency,
	verifyInclusion,
} from '../src/mmr.js';

/** Build an MMR from `n` leaf values; return the node array and the leaf→node-index map. */
async function build(n: number): Promise<{ nodes: Uint8Array[]; leafIndices: number[] }> {
	const nodes: Uint8Array[] = [];
	const leafIndices: number[] = [];
	for (let k = 0; k < n; k++) {
		leafIndices.push(await addLeafHash(nodes, await leafHash(`rollup-${k}`)));
	}
	return { nodes, leafIndices };
}

describe('index math (draft reference values)', () => {
	it('index_height matches the reference MMR layout', () => {
		// indices: 0,1 leaves; 2 = parent(0,1); 3,4 leaves; 5 = parent(3,4); 6 = parent(2,5)
		expect([0, 1, 2, 3, 4, 5, 6].map(indexHeight)).toEqual([0, 0, 1, 0, 0, 1, 2]);
	});
	it('peaks for a 7-node tree is a single peak at index 6', () => {
		expect(peakIndices(7)).toEqual([6]);
		// 11 nodes = 7 leaves: a 4-leaf subtree (peak 6), a 2-leaf subtree (peak 9), a 1-leaf peak (10)
		expect(peakIndices(11)).toEqual([6, 9, 10]);
	});
});

describe('MMR inclusion', () => {
	it('every appended leaf proves inclusion against the committed root', async () => {
		const N = 21;
		const { nodes, leafIndices } = await build(N);
		const count = nodes.length;
		const root = await baggedRoot(count, accumulatorHashes(nodes, count));

		for (const idx of leafIndices) {
			const proof = proveInclusion(nodes, idx, count);
			expect(await verifyInclusion(proof, root)).toBe(true);
		}
	});

	it('a tampered leaf fails verification', async () => {
		const { nodes, leafIndices } = await build(8);
		const count = nodes.length;
		const root = await baggedRoot(count, accumulatorHashes(nodes, count));
		const idx = leafIndices[3] as number;
		const proof = proveInclusion(nodes, idx, count);
		const tampered: InclusionProof = {
			...proof,
			leaf: await leafHash('rollup-EVIL'),
		};
		expect(await verifyInclusion(tampered, root)).toBe(false);
	});

	it('a proof does not verify against a different tree root', async () => {
		const a = await build(8);
		const b = await build(9);
		const proof = proveInclusion(a.nodes, a.leafIndices[2] as number, a.nodes.length);
		const rootB = await baggedRoot(b.nodes.length, accumulatorHashes(b.nodes, b.nodes.length));
		expect(await verifyInclusion(proof, rootB)).toBe(false);
	});

	it('rejects an inclusion proof for an INTERIOR (non-leaf) node', async () => {
		// Node index 2 is an interior aggregation node (height 1), not a committed leaf. A proof for it
		// folds to a real peak, so it must be rejected explicitly, not accepted as a member.
		const { nodes } = await build(8);
		const count = nodes.length;
		const root = await baggedRoot(count, accumulatorHashes(nodes, count));
		expect(indexHeight(2)).not.toBe(0);
		const interiorProof = proveInclusion(nodes, 2, count);
		expect(await verifyInclusion(interiorProof, root)).toBe(false);
	});
});

describe('MMR consistency', () => {
	it('proves an earlier checkpoint is a prefix of a later one', async () => {
		// Grow to sizeFrom, snapshot the root, keep appending to sizeTo.
		const nodes: Uint8Array[] = [];
		for (let k = 0; k < 5; k++) await addLeafHash(nodes, await leafHash(`r-${k}`));
		const sizeFrom = nodes.length;
		const rootFrom = await baggedRoot(sizeFrom, accumulatorHashes(nodes, sizeFrom));

		for (let k = 5; k < 12; k++) await addLeafHash(nodes, await leafHash(`r-${k}`));
		const sizeTo = nodes.length;
		const rootTo = await baggedRoot(sizeTo, accumulatorHashes(nodes, sizeTo));

		const proof = proveConsistency(nodes, sizeFrom, sizeTo);
		expect(await verifyConsistency(proof, rootFrom, rootTo)).toBe(true);

		// A wrong "from" root must fail.
		const bogus = await baggedRoot(sizeFrom, accumulatorHashes(nodes, sizeTo));
		expect(await verifyConsistency(proof, bogus, rootTo)).toBe(false);
	});

	it('rejects a forged proof whose inclusions do not cover the old peaks', async () => {
		// Old peaks bag to the genuine rootFrom, but the inclusions are swapped for a proof of an
		// UNRELATED leaf that still folds to a new peak. Without binding inc.leaf to peaksFrom[i] this
		// forgery would pass, letting a log rewrite history between checkpoints.
		const nodes: Uint8Array[] = [];
		for (let k = 0; k < 5; k++) await addLeafHash(nodes, await leafHash(`c-${k}`));
		const sizeFrom = nodes.length;
		const rootFrom = await baggedRoot(sizeFrom, accumulatorHashes(nodes, sizeFrom));
		for (let k = 5; k < 12; k++) await addLeafHash(nodes, await leafHash(`c-${k}`));
		const sizeTo = nodes.length;
		const rootTo = await baggedRoot(sizeTo, accumulatorHashes(nodes, sizeTo));

		const proof = proveConsistency(nodes, sizeFrom, sizeTo);
		expect(await verifyConsistency(proof, rootFrom, rootTo)).toBe(true);

		const unrelated = proveInclusion(nodes, 0, sizeTo);
		expect(unrelated.leaf).not.toEqual(proof.peaksFrom[0]);
		const forged = {
			...proof,
			inclusions: [
				{
					index: unrelated.index,
					leaf: unrelated.leaf,
					path: unrelated.path,
				},
				...proof.inclusions.slice(1),
			],
		};
		expect(await verifyConsistency(forged, rootFrom, rootTo)).toBe(false);
	});
});

describe('store-backed MMR (bounded reads)', () => {
	/** A NodeStore wrapping an array that records every index it is asked for. */
	function countingStore(nodes: Uint8Array[]): {
		store: NodeStore;
		reads: Set<number>;
	} {
		const reads = new Set<number>();
		const store: NodeStore = {
			getMany: (indices) => {
				for (const i of indices) reads.add(i);
				return Promise.resolve(indices.map((i) => nodes[i] as Uint8Array));
			},
		};
		return { store, reads };
	}

	it('appendLeaves reproduces addLeafHash node-for-node without loading the tree', async () => {
		// Grow an array MMR and an incremental store-backed one in lockstep; nodes must match exactly.
		const arrNodes: Uint8Array[] = [];
		const persisted: Uint8Array[] = [];
		for (let k = 0; k < 20; k++) {
			await addLeafHash(arrNodes, await leafHash(`e-${k}`));
			const { store, reads } = countingStore(persisted);
			const res = await appendLeaves(store, persisted.length, [await leafHash(`e-${k}`)]);
			// Append reads only current peaks — never the whole tree.
			expect(reads.size).toBeLessThanOrEqual(peakIndices(persisted.length).length);
			for (const n of res.newNodes) persisted[n.index] = n.hash;
		}
		expect(persisted.map((n) => [...n])).toEqual(arrNodes.map((n) => [...n]));
		expect(await mmrRootStore(arrayStore(persisted), persisted.length)).toEqual(
			await mmrRoot(arrNodes),
		);
	});

	it('proveInclusionStore equals proveInclusion, verifies, and reads O(log n) nodes', async () => {
		const N = 100;
		const nodes: Uint8Array[] = [];
		const leaves: number[] = [];
		for (let k = 0; k < N; k++) leaves.push(await addLeafHash(nodes, await leafHash(`i-${k}`)));
		const count = nodes.length;
		const root = await mmrRoot(nodes);
		const idx = leaves[42] as number;

		const arrayProof = proveInclusion(nodes, idx, count);
		const { store, reads } = countingStore(nodes);
		const storeProof = await proveInclusionStore(store, idx, count);

		expect(storeProof.path.map((h) => [...h])).toEqual(arrayProof.path.map((h) => [...h]));
		expect(storeProof.peaks.map((h) => [...h])).toEqual(arrayProof.peaks.map((h) => [...h]));
		expect(await verifyInclusion(storeProof, root)).toBe(true);
		// A 100-leaf tree has ~199 nodes; the store must touch far fewer than all of them.
		expect(reads.size).toBeLessThan(count / 2);
	});

	it('proveConsistencyStore equals proveConsistency and verifies', async () => {
		const nodes: Uint8Array[] = [];
		for (let k = 0; k < 9; k++) await addLeafHash(nodes, await leafHash(`x-${k}`));
		const sizeFrom = nodes.length;
		const rootFrom = await mmrRoot(nodes);
		for (let k = 9; k < 25; k++) await addLeafHash(nodes, await leafHash(`x-${k}`));
		const sizeTo = nodes.length;
		const rootTo = await mmrRoot(nodes);

		const storeProof = await proveConsistencyStore(arrayStore(nodes), sizeFrom, sizeTo);
		const arrayProof = proveConsistency(nodes, sizeFrom, sizeTo);
		expect(storeProof.peaksFrom.map((h) => [...h])).toEqual(
			arrayProof.peaksFrom.map((h) => [...h]),
		);
		expect(await verifyConsistency(storeProof, rootFrom, rootTo)).toBe(true);
	});
});
