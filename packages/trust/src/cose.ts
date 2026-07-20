// COSE_Sign1 (RFC 9052) over Web Crypto, the canonical SCITT / COSE-receipts wire format. CBOR is
// encoded with `cborg` (pure ESM, proven to run under @cloudflare/vitest-pool-workers). We sign the
// RFC 9052 `Sig_structure` ("Signature1" || protected || external_aad || payload) and carry `alg`+`kid`
// in the protected header. Signatures are the RAW Web Crypto form (64-byte Ed25519; 64-byte
// ES256 r||s) — exactly what COSE mandates — so verify is a straight crypto.subtle.verify. This runs
// unchanged in workerd and Node. The JWS forms remain for HTTP contexts; COSE is the SCITT-native one.

import { decode as cborDecode, encode as cborEncode } from 'cborg';
import { base64urlToBytes } from './bytes.js';
import { type SigningAlg, type SigningKey, type SubtleKey, importPublicJwk } from './keys.js';

/** COSE algorithm identifiers (IANA COSE Algorithms registry): EdDSA = -8, ES256 = -7. */
const COSE_ALG: Record<SigningAlg, number> = { EdDSA: -8, ES256: -7 };
const ALG_FOR_COSE: Record<number, SigningAlg> = {
	[-8]: 'EdDSA',
	[-7]: 'ES256',
};

/** COSE header label 1 = alg, label 4 = kid. */
const HDR_ALG = 1;
const HDR_KID = 4;

/** CBOR tag 18 identifies a COSE_Sign1 structure. */
const COSE_SIGN1_TAG = 18;

const enc = new TextEncoder();

/** Web Crypto sign/verify params for a COSE alg (typed locally: the DOM lib types are not in the
 * workers-types environment). */
function algParams(alg: SigningAlg): { name: string; hash?: string } {
	return alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
}

/** Build the RFC 9052 Sig_structure bytes that are actually signed/verified. */
function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
	return cborEncode(['Signature1', protectedBytes, new Uint8Array(0), payload]);
}

/** A decoded COSE_Sign1: protected header params, kid, and the message payload. */
export interface CoseSign1Verification {
	protectedHeader: { alg: SigningAlg; kid?: string };
	payload: Uint8Array;
}

/**
 * Produce a tagged COSE_Sign1 (RFC 9052) over `payload`, signed with `key`. The protected header
 * carries `alg` (+`kid`); the unprotected header is empty. Returns the CBOR-encoded, tag-18 message.
 */
export async function signCoseSign1(payload: Uint8Array, key: SigningKey): Promise<Uint8Array> {
	const protectedMap = new Map<number, unknown>([
		[HDR_ALG, COSE_ALG[key.alg]],
		[HDR_KID, enc.encode(key.kid)],
	]);
	const protectedBytes = cborEncode(protectedMap);
	const toSign = sigStructure(protectedBytes, payload);
	const signature = new Uint8Array(
		await crypto.subtle.sign(algParams(key.alg), key.privateKey as SubtleKey, toSign),
	);
	const message = [protectedBytes, new Map<number, unknown>(), payload, signature];
	// Prepend the 1-byte CBOR tag-18 head (0xd2) to the untagged 4-element array; cborg has no direct
	// tag-writer, and the head is fixed for a single-byte tag value.
	const body = cborEncode(message);
	const tagged = new Uint8Array(body.length + 1);
	tagged[0] = 0xc0 | COSE_SIGN1_TAG; // 0xd2 = major type 6 (tag), value 18
	tagged.set(body, 1);
	return tagged;
}

/** cborg decode options: integer-keyed maps → JS Map, and tag 18 (COSE_Sign1) passes its array through. */
const DECODE_OPTS = (() => {
	const tags: ((inner: unknown) => unknown)[] = [];
	tags[COSE_SIGN1_TAG] = (inner) => inner;
	return { useMaps: true, tags };
})();

/** Decode a COSE_Sign1 message to its four elements, tolerating the tag being present or stripped. */
function decodeCoseSign1(
	message: Uint8Array,
): [Uint8Array, Map<unknown, unknown>, Uint8Array, Uint8Array] {
	const arr = cborDecode(message, DECODE_OPTS) as unknown[];
	if (!Array.isArray(arr) || arr.length !== 4) {
		throw new Error('malformed COSE_Sign1 (expected a 4-element array)');
	}
	const [protectedBytes, unprotected, payload, signature] = arr;
	if (
		!(protectedBytes instanceof Uint8Array) ||
		!(payload instanceof Uint8Array) ||
		!(signature instanceof Uint8Array)
	) {
		throw new Error('malformed COSE_Sign1 (protected/payload/signature must be bstr)');
	}
	return [protectedBytes, unprotected as Map<unknown, unknown>, payload, signature];
}

/** Parse the protected header bstr into its alg + kid. */
function parseProtected(protectedBytes: Uint8Array): {
	alg: SigningAlg;
	kid?: string;
} {
	const map = cborDecode(protectedBytes, DECODE_OPTS) as Map<unknown, unknown>;
	if (!(map instanceof Map)) throw new Error('COSE protected header is not a map');
	const alg = ALG_FOR_COSE[map.get(HDR_ALG) as number];
	if (!alg) throw new Error(`unsupported COSE alg ${String(map.get(HDR_ALG))}`);
	const kidRaw = map.get(HDR_KID);
	const kid = kidRaw instanceof Uint8Array ? new TextDecoder().decode(kidRaw) : undefined;
	return { alg, kid };
}

/**
 * Verify a COSE_Sign1 against `publicJwk`: reconstruct the Sig_structure and check the raw signature
 * with Web Crypto. Throws on any failure (bad shape, unsupported alg, alg mismatch, or bad signature).
 */
export async function verifyCoseSign1(
	message: Uint8Array,
	publicJwk: Parameters<typeof importPublicJwk>[0],
): Promise<CoseSign1Verification> {
	const [protectedBytes, , payload, signature] = decodeCoseSign1(message);
	const header = parseProtected(protectedBytes);
	const { key, alg } = await importPublicJwk(publicJwk);
	if (alg !== header.alg) throw new Error('COSE alg does not match the verification key');
	const toVerify = sigStructure(protectedBytes, payload);
	const ok = await crypto.subtle.verify(algParams(alg), key as SubtleKey, signature, toVerify);
	if (!ok) throw new Error('COSE_Sign1 signature did not verify');
	return { protectedHeader: header, payload };
}

/**
 * Read a COSE_Sign1's protected header + payload WITHOUT verifying (e.g. to recover the `kid` and pick
 * a key). Callers MUST still call {@link verifyCoseSign1} before trusting anything.
 */
export function inspectCoseSign1(message: Uint8Array): CoseSign1Verification {
	const [protectedBytes, , payload] = decodeCoseSign1(message);
	return { protectedHeader: parseProtected(protectedBytes), payload };
}

/** base64url-encode a COSE_Sign1 message for transport inside JSON envelopes. */
export { bytesToBase64url as coseToBase64url } from './bytes.js';

/** Decode a base64url COSE_Sign1 message back to bytes. */
export function coseFromBase64url(b64u: string): Uint8Array {
	return base64urlToBytes(b64u);
}
