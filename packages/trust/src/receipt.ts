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

/** IMPORTANT: `bytesEqual` matches two empty arrays, so an empty `leaf` and `peaks` entry fold to an
 * empty peak and bag to the root of a size-0 checkpoint — a forged inclusion proof against a signed
 * empty log. Every hex field of an MMR_SHA256 receipt is a SHA-256 digest; pin that here. */
function checkedDigest(hex: string): Uint8Array {
	const bytes = fromHex(hex);
	if (bytes.length !== 32) throw new Error('receipt field is not a SHA-256 digest');
	return bytes;
}

/** IMPORTANT: a receipt counter reaches `u64be`, which wraps mod 2^64, so an out-of-range `sizeTo`
 * defeats `verifyConsistency`'s `sizeTo < sizeFrom` gate while still binding to the signed root. */
function checkedCount(n: number): number {
	if (!Number.isSafeInteger(n) || n < 0) throw new Error('receipt counter is not a node count');
	return n;
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
		index: checkedCount(r.index),
		leaf: checkedDigest(r.leaf),
		path: r.path.map(checkedDigest),
		size: checkedCount(r.size),
		peaks: r.peaks.map(checkedDigest),
	};
}

/** Verify a hex inclusion receipt against a checkpoint's hex root. Fails closed: a malformed hex or
 * numeric field returns false rather than throwing, regardless of caller error handling. */
export async function verifyInclusionReceipt(
	r: InclusionReceipt,
	rootHex: string,
): Promise<boolean> {
	try {
		return await verifyInclusion(receiptToInclusion(r), checkedDigest(rootHex));
	} catch {
		return false;
	}
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
		sizeFrom: checkedCount(r.sizeFrom),
		sizeTo: checkedCount(r.sizeTo),
		peaksFrom: r.peaksFrom.map(checkedDigest),
		inclusions: r.inclusions.map((i) => ({
			index: checkedCount(i.index),
			leaf: checkedDigest(i.leaf),
			path: i.path.map(checkedDigest),
		})),
		peaksTo: r.peaksTo.map(checkedDigest),
	};
}

/** Verify a hex consistency receipt against two checkpoint hex roots. Fails closed on malformed input. */
export async function verifyConsistencyReceipt(
	r: ConsistencyReceipt,
	rootFromHex: string,
	rootToHex: string,
): Promise<boolean> {
	try {
		return await verifyConsistency(
			receiptToConsistency(r),
			checkedDigest(rootFromHex),
			checkedDigest(rootToHex),
		);
	} catch {
		return false;
	}
}
