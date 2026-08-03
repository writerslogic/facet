// The verification kernel: MMR inclusion, RFC 8785 canonicalization, RFC 7638 thumbprints and
// detached-JWS (RFC 7515 App. F) signature checking, over Web Crypto only. No `jose`, no CBOR, no new
// dependency — and no React, so it can be unit-tested on its own.
//
// WHY THIS IS NOT `import { … } from '@facet/trust'`:
//  1. It does not compile here. The trust package is typed against @cloudflare/workers-types, whose
//     `crypto.subtle.digest` accepts a plain `Uint8Array`; under the dashboard's `lib: DOM` the same
//     call is an error (`Uint8Array<ArrayBufferLike>` is not `BufferSource`, since DOM narrowed
//     ArrayBufferView to ArrayBuffer). tsc typechecks imported .ts sources, so importing trust from
//     the dashboard fails `pnpm typecheck` inside trust's own bytes.ts. Fixing that means editing the
//     trust package, which owns the server and CLI too.
//  2. The trust barrel re-exports cose.ts, which imports `cborg` — a DEV dependency of that package.
//     Pulling it into the browser bundle would ship a dev-only dep and break any `--prod` install.
//     That is also why a COSE_Sign1 proof is reported here as "not checked", never as a pass:
//     decoding it needs exactly that CBOR library.
//  3. It is the right shape for a verifier anyway. Code shared with the prover shares the prover's
//     bugs; only an independent re-derivation can disagree with it. src/test/provenance.test.tsx pins
//     the two together — every fixture is produced by the REAL @facet/trust (loaded at runtime, where
//     its workers-types typing is irrelevant) and this kernel must return the same verdict as trust's
//     own verifier on all of them, valid and tampered alike.
//
// The MMR algorithms mirror the MMR_SHA256 profile (draft-bryce-cose-receipts-mmr-profile) as
// implemented in packages/trust/src/mmr.ts.

import type { InclusionProof, SignedCheckpoint } from '../hooks/transparency.js';

const textEncoder = new TextEncoder();

function utf8(s: string): Uint8Array {
	return textEncoder.encode(s);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
	// `.buffer` is an ArrayBufferLike, which TS 5.7 no longer widens to BufferSource; concatBytes
	// always allocates a fresh plain ArrayBuffer, so this assertion is describing what is already true.
	const joined = concatBytes(...parts);
	const digest = await crypto.subtle.digest('SHA-256', joined.buffer as ArrayBuffer);
	return new Uint8Array(digest);
}

export function toHex(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

/** Strict hex decode: a malformed field must fail, never decode to valid-but-wrong bytes. */
export function fromHex(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error('hex string has an odd length');
	if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('hex string has a non-hex character');
	const out = new Uint8Array(hex.length / 2);
	for (let k = 0; k < out.length; k++) out[k] = Number.parseInt(hex.slice(k * 2, k * 2 + 2), 16);
	return out;
}

function base64urlToBytes(b64u: string): Uint8Array {
	const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function bytesToBase64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 8785 (JCS): keys sorted by code unit, no incidental whitespace — so signer and verifier agree
 * on exactly which bytes were signed. */
export function canonicalJson(value: unknown, depth = 0): string {
	if (depth > 256) throw new Error('cannot canonicalize: nesting too deep');
	if (value === null) return 'null';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error('cannot canonicalize a non-finite number');
		return JSON.stringify(value);
	}
	if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj)
			.filter((k) => obj[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], depth + 1)}`).join(',')}}`;
	}
	throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

export function canonicalizeBytes(value: unknown): Uint8Array {
	return utf8(canonicalJson(value));
}

export async function canonicalDigestHex(value: unknown): Promise<string> {
	return toHex(await sha256(canonicalizeBytes(value)));
}

/** Leaf hash `H(x)`: per the MMR_SHA256 profile leaves carry no domain-separation tag. */
export function leafHash(x: Uint8Array): Promise<Uint8Array> {
	return sha256(x);
}

/** A one-based node position as an unsigned 64-bit big-endian byte string. */
function u64be(n: number): Uint8Array {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
	return out;
}

/** `H(pos_be64 || left || right)` — the interior-node hash that binds a node to its position. */
function hashPosPair(pos: number, left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
	return sha256(u64be(pos), left, right);
}

function allOnes(n: number): boolean {
	return (n & (n + 1)) === 0 && n !== 0;
}

/** Zero-based height of the node at index `i`. Leaves are height 0. */
export function indexHeight(i: number): number {
	let pos = i + 1;
	while (!allOnes(pos)) {
		pos = pos - (1 << (31 - Math.clz32(pos))) + 1;
	}
	return 31 - Math.clz32(pos);
}

/** Bag the accumulator peaks into one root commitment: `H(count_be64 || peak0 || peak1 || …)`. */
export function baggedRoot(count: number, peaks: Uint8Array[]): Promise<Uint8Array> {
	return sha256(u64be(count), ...peaks);
}

/** One SHA-256 combination on the walk from the leaf to its accumulator peak. */
export interface FoldStep {
	/** 1-based step number. */
	step: number;
	/** Tree level after this combination (leaf level is 0). */
	height: number;
	/** One-based MMR node position committed inside the hash — what makes the path unforgeable. */
	position: number;
	/** Which side the supplied sibling sits on. */
	side: 'left' | 'right';
	sibling: string;
	/** Running hash before this step. */
	from: string;
	/** Running hash after this step. */
	to: string;
}

/**
 * Re-fold an inclusion path, recording every intermediate so the walk can be drawn and stepped
 * through. The side a sibling joins on is decided by the tree's shape at this index, not by the
 * proof — which is why a path cannot be replayed against a different position.
 */
export async function foldPath(
	index: number,
	leaf: Uint8Array,
	path: Uint8Array[],
): Promise<FoldStep[]> {
	const steps: FoldStep[] = [];
	let acc = leaf;
	let g = indexHeight(index);
	let idx = index;
	for (let k = 0; k < path.length; k++) {
		const sibling = path[k] as Uint8Array;
		const from = acc;
		let side: 'left' | 'right';
		if (indexHeight(idx + 1) > g) {
			idx += 1;
			acc = await hashPosPair(idx + 1, sibling, acc);
			side = 'left';
		} else {
			idx += 2 << g;
			acc = await hashPosPair(idx + 1, acc, sibling);
			side = 'right';
		}
		g += 1;
		steps.push({
			step: k + 1,
			height: g,
			position: idx + 1,
			side,
			sibling: toHex(sibling),
			from: toHex(from),
			to: toHex(acc),
		});
	}
	return steps;
}

/**
 * Verify an MMR inclusion receipt against a root: the node folds to one of the accumulator peaks, and
 * the accumulator bags to that root. Includes the check that the index is a height-0 LEAF — without
 * it an interior aggregation node would verify as a committed log entry, because the profile gives
 * leaves no domain-separation tag. Fails closed on malformed input rather than throwing.
 */
export async function verifyInclusionReceipt(
	receipt: InclusionProof['receipt'],
	rootHex: string,
): Promise<boolean> {
	try {
		if (!Number.isInteger(receipt.index) || receipt.index < 0) return false;
		if (indexHeight(receipt.index) !== 0) return false;
		const steps = await foldPath(
			receipt.index,
			fromHex(receipt.leaf),
			receipt.path.map(fromHex),
		);
		const peak = steps.length ? (steps[steps.length - 1] as FoldStep).to : receipt.leaf;
		if (!receipt.peaks.includes(peak)) return false;
		return toHex(await baggedRoot(receipt.size, receipt.peaks.map(fromHex))) === rootHex;
	} catch {
		return false;
	}
}

/** JWS algorithms this verifier can actually check with Web Crypto. */
type VerifyAlg = 'EdDSA' | 'ES256';

function importParams(
	alg: VerifyAlg,
): { name: 'Ed25519' } | { name: 'ECDSA'; namedCurve: 'P-256' } {
	return alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
}

function verifyParams(alg: VerifyAlg): { name: 'Ed25519' } | { name: 'ECDSA'; hash: 'SHA-256' } {
	return alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
}

/** RFC 7638 JWK thumbprint: SHA-256 over the required members only, in lexicographic order. This is
 * what makes `kid` a commitment to the key rather than a label anyone could copy onto their own. */
export async function jwkThumbprint(jwk: Record<string, unknown>): Promise<string> {
	const required =
		jwk.kty === 'OKP'
			? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
			: jwk.kty === 'EC'
				? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
				: null;
	if (!required) throw new Error(`unsupported key type ${String(jwk.kty)}`);
	return bytesToBase64url(await sha256(canonicalizeBytes(required)));
}

export interface ProofCheck {
	ok: boolean;
	reason?: string;
	/** True when the failure is "this browser cannot do it", not "the signature is wrong". */
	unsupported?: boolean;
}

/**
 * Verify a detached-JWS statement proof (RFC 7515 App. F) over the RFC 8785 canonical bytes of
 * `payload`. Mirrors `verifyDetachedProof` in @facet/trust, including both bindings that make the
 * proof mean anything: the protected header's `kid`/`alg` must match the declared ones (otherwise
 * they are unauthenticated), and `kid` must be the RFC 7638 thumbprint of the embedded key
 * (otherwise an attacker keeps a self-consistent kid while swapping in their own key). Never throws.
 */
export async function verifyStatementProof(
	proof: SignedCheckpoint['proof'] | undefined,
	payload: unknown,
): Promise<ProofCheck> {
	if (proof?.type !== 'DetachedJWS') {
		return { ok: false, reason: `unsupported proof type ${String(proof?.type)}` };
	}
	try {
		const parts = (proof.jws ?? '').split('.');
		if (parts.length !== 3 || parts[1] !== '') {
			return { ok: false, reason: 'malformed detached JWS' };
		}
		const header = JSON.parse(
			new TextDecoder().decode(base64urlToBytes(parts[0] as string)),
		) as { alg?: string; kid?: string };
		if (header.alg !== 'EdDSA' && header.alg !== 'ES256') {
			return { ok: false, reason: `unsupported signature algorithm ${String(header.alg)}` };
		}
		const alg: VerifyAlg = header.alg;
		if (header.kid !== proof.kid) {
			return { ok: false, reason: 'protected-header kid does not match proof kid' };
		}
		if (proof.alg !== undefined && header.alg !== proof.alg) {
			return { ok: false, reason: 'protected-header alg does not match proof alg' };
		}
		const jwk = proof.publicJwk as unknown as Record<string, unknown>;
		if (proof.kid !== (await jwkThumbprint(jwk))) {
			return { ok: false, reason: 'kid is not the RFC 7638 thumbprint of publicJwk' };
		}
		let key: CryptoKey;
		try {
			key = await crypto.subtle.importKey('jwk', jwk, importParams(alg), false, ['verify']);
		} catch (e) {
			// Ed25519 in Web Crypto is recent. A browser without it cannot check this signature, which
			// is a fact about the browser — reporting it as an invalid signature would be a lie.
			return {
				ok: false,
				unsupported: true,
				reason: `this browser cannot verify ${alg} signatures (${e instanceof Error ? e.message : 'importKey failed'})`,
			};
		}
		const signingInput = utf8(`${parts[0]}.${bytesToBase64url(canonicalizeBytes(payload))}`);
		const signature = base64urlToBytes(parts[2] as string);
		const ok = await crypto.subtle.verify(
			verifyParams(alg),
			key,
			signature as Uint8Array<ArrayBuffer>,
			signingInput as Uint8Array<ArrayBuffer>,
		);
		return ok ? { ok: true } : { ok: false, reason: 'signature does not verify' };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : 'verification failed' };
	}
}
