// JSON (hex-serialized) DTOs for MMR inclusion/consistency proofs, so they can travel over HTTP and
// be verified offline by the CLI. These wrap the binary proofs from mmr.ts against a checkpoint's
// bagged root. Profiled against draft-bryce-cose-receipts-mmr-profile; a COSE_Sign1 receipt encoding
// is format-ready but gated on a workerd-verified COSE library (see the trust README).

import { fromHex, toHex } from './bytes.js';
import {
	type ConsistencyProof,
	type InclusionProof,
	verifyConsistency,
	verifyInclusion,
} from './mmr.js';

export interface InclusionReceipt {
	index: number;
	leaf: string;
	path: string[];
	size: number;
	peaks: string[];
}

export interface ConsistencyReceipt {
	sizeFrom: number;
	sizeTo: number;
	peaksFrom: string[];
	inclusions: { index: number; leaf: string; path: string[] }[];
	peaksTo: string[];
}

/** Serialize a binary inclusion proof to a hex receipt. */
export function inclusionToReceipt(p: InclusionProof): InclusionReceipt {
	return {
		index: p.index,
		leaf: toHex(p.leaf),
		path: p.path.map(toHex),
		size: p.size,
		peaks: p.peaks.map(toHex),
	};
}

/** Deserialize a hex inclusion receipt back to a binary proof. */
export function receiptToInclusion(r: InclusionReceipt): InclusionProof {
	return {
		index: r.index,
		leaf: fromHex(r.leaf),
		path: r.path.map(fromHex),
		size: r.size,
		peaks: r.peaks.map(fromHex),
	};
}

/** Verify a hex inclusion receipt against a checkpoint's hex root. */
export function verifyInclusionReceipt(r: InclusionReceipt, rootHex: string): Promise<boolean> {
	return verifyInclusion(receiptToInclusion(r), fromHex(rootHex));
}

/** Serialize a binary consistency proof to a hex receipt. */
export function consistencyToReceipt(p: ConsistencyProof): ConsistencyReceipt {
	return {
		sizeFrom: p.sizeFrom,
		sizeTo: p.sizeTo,
		peaksFrom: p.peaksFrom.map(toHex),
		inclusions: p.inclusions.map((i) => ({
			index: i.index,
			leaf: toHex(i.leaf),
			path: i.path.map(toHex),
		})),
		peaksTo: p.peaksTo.map(toHex),
	};
}

/** Deserialize a hex consistency receipt back to a binary proof. */
export function receiptToConsistency(r: ConsistencyReceipt): ConsistencyProof {
	return {
		sizeFrom: r.sizeFrom,
		sizeTo: r.sizeTo,
		peaksFrom: r.peaksFrom.map(fromHex),
		inclusions: r.inclusions.map((i) => ({
			index: i.index,
			leaf: fromHex(i.leaf),
			path: i.path.map(fromHex),
		})),
		peaksTo: r.peaksTo.map(fromHex),
	};
}

/** Verify a hex consistency receipt against two checkpoint hex roots. */
export function verifyConsistencyReceipt(
	r: ConsistencyReceipt,
	rootFromHex: string,
	rootToHex: string,
): Promise<boolean> {
	return verifyConsistency(receiptToConsistency(r), fromHex(rootFromHex), fromHex(rootToHex));
}
