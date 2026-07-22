// Deployment key handling, Workers-native. Keys are Ed25519 (preferred) or ECDSA P-256, all handled
// through Web Crypto via `jose` so they run unchanged in workerd. The private key lives only as a
// Worker secret (a JWK string); the public half is published as a JWK/JWKS and referenced by the DID
// document. `kid` is the RFC 7638 JWK thumbprint so it is stable and self-describing.

import {
	type JWK,
	type KeyLike,
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
	importJWK,
} from 'jose';

/** JWS `alg` values this deployment supports. Ed25519 is preferred; P-256 is the ECDSA fallback. */
export type SigningAlg = 'EdDSA' | 'ES256';

/** The Web Crypto key type `crypto.subtle.sign` expects, derived from the runtime so we do not depend
 * on the `CryptoKey` global type name being exported (it is not, under @types/node). */
export type SubtleKey = Parameters<typeof crypto.subtle.sign>[1];

/** A loaded deployment signing key: the private key plus its published public JWK and `kid`. The
 * private key is a real Web Crypto key (imported via crypto.subtle) so the raw RFC 9421 / Data
 * Integrity signing paths work under both workerd and Node; jose's JWS operations accept it too. */
export interface SigningKey {
	alg: SigningAlg;
	kid: string;
	privateKey: SubtleKey;
	/** Public JWK (with `kid`/`alg`/`use`) suitable for a JWKS. */
	publicJwk: JWK;
}

/** Map a JWK to the `alg` we sign with, rejecting unsupported curves. */
function algForJwk(jwk: JWK): SigningAlg {
	if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'EdDSA';
	if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
	throw new Error(`unsupported key type for signing: kty=${jwk.kty} crv=${jwk.crv}`);
}

/** Public-JWK view of a private JWK: strip every private member (not just `d`) and stamp use/alg/kid.
 * Uses the full private-member stripper so no private scalar can reach the wire if the key set ever
 * grows beyond OKP/EC. The thumbprint is over RFC 7638 required members only, so this is kid-stable. */
async function toPublicJwk(privateJwk: JWK, alg: SigningAlg): Promise<JWK> {
	const pub = toPublicJwkFields(privateJwk);
	const kid = await calculateJwkThumbprint(pub);
	return { ...pub, alg, use: 'sig', kid };
}

/** Web Crypto import parameters for signing with a given alg. */
function signImportParams(
	alg: SigningAlg,
): { name: 'Ed25519' } | { name: 'ECDSA'; namedCurve: 'P-256' } {
	return alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
}

/** Load the deployment signing key from a JWK string (the `FACET_SIGNING_JWK` Worker secret). The
 * private key is imported through `crypto.subtle.importKey` so it is a real Web Crypto CryptoKey in
 * BOTH workerd and Node (jose's importJWK yields a Node KeyObject that crypto.subtle cannot use for
 * the raw RFC 9421 / Data Integrity signing paths). jose's JWS operations accept a CryptoKey too. */
export async function loadSigningKey(jwkJson: string): Promise<SigningKey> {
	let privateJwk: JWK;
	try {
		privateJwk = JSON.parse(jwkJson) as JWK;
	} catch {
		throw new Error('FACET_SIGNING_JWK is not valid JSON');
	}
	if (!privateJwk.d) throw new Error('FACET_SIGNING_JWK must be a private JWK (missing `d`)');
	const alg = algForJwk(privateJwk);
	const privateKey = await crypto.subtle.importKey(
		'jwk',
		privateJwk as never,
		signImportParams(alg),
		false,
		['sign'],
	);
	const publicJwk = await toPublicJwk(privateJwk, alg);
	return { alg, kid: publicJwk.kid as string, privateKey, publicJwk };
}

/** Generate a fresh extractable key pair and return both JWKs (for provisioning/tests). */
export async function generateSigningJwk(
	alg: SigningAlg = 'EdDSA',
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
	const { publicKey, privateKey } = await generateKeyPair(alg, {
		extractable: true,
	});
	const privateJwk = await exportJWK(privateKey);
	const publicJwk = await toPublicJwk(await exportJWK(publicKey), alg);
	privateJwk.alg = alg;
	privateJwk.kid = publicJwk.kid;
	return { privateJwk, publicJwk };
}

/** A JWKS document: a set of public JWKs. */
export interface Jwks {
	keys: JWK[];
}

/** Build a JWKS document from one or more public JWKs. */
export function toJwks(publicJwks: JWK[]): Jwks {
	return { keys: publicJwks };
}

/** Import a public JWK for verification, inferring the `alg`. Returns a jose KeyLike (CryptoKey in
 * workerd, KeyObject in Node) — both are accepted by jose's verify; the RFC 9421 raw path narrows
 * to CryptoKey itself. */
export async function importPublicJwk(jwk: JWK): Promise<{ key: KeyLike; alg: SigningAlg }> {
	const alg = jwk.alg === 'ES256' || jwk.alg === 'EdDSA' ? jwk.alg : algForJwk(jwk);
	const key = await importJWK(jwk, alg);
	if (key instanceof Uint8Array) throw new Error('public JWK imported as a symmetric key');
	return { key, alg };
}

/** Web Crypto sign/verify algorithm params for a `SigningAlg` (distinct from `signImportParams`, which
 * is for `importKey`). The single home for the alg→params map, shared by every raw `crypto.subtle`
 * sign/verify path (COSE_Sign1, RFC 9421) so a new alg is added in exactly one place. */
export function subtleSignParams(
	alg: SigningAlg,
): { name: 'Ed25519' } | { name: 'ECDSA'; hash: 'SHA-256' } {
	return alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
}

/** Import a PUBLIC JWK as a real Web Crypto `CryptoKey` for the raw `crypto.subtle.verify` paths (COSE,
 * RFC 9421). Uses `crypto.subtle.importKey('jwk', …)` so the result is a `CryptoKey` in BOTH workerd AND
 * Node — unlike jose's `importJWK`, which yields a Node `KeyObject` that `crypto.subtle` cannot use (the
 * cause of COSE/HTTP-sig verification failing under Node). */
export async function importVerifyKey(jwk: JWK): Promise<{ key: SubtleKey; alg: SigningAlg }> {
	const alg = jwk.alg === 'ES256' || jwk.alg === 'EdDSA' ? jwk.alg : algForJwk(jwk);
	const key = await crypto.subtle.importKey('jwk', jwk as never, signImportParams(alg), false, [
		'verify',
	]);
	return { key, alg };
}

/** Private JWK members (JWK/JWA): the fields that make a JWK a *private* key. */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

/** Return a copy of `jwk` with every private member stripped — a public-only JWK safe to publish or
 * embed. Guards against a private key leaking on the wire when a public one is expected. */
export function toPublicJwkFields(jwk: JWK): JWK {
	const out = { ...jwk } as Record<string, unknown>;
	for (const m of PRIVATE_JWK_MEMBERS) delete out[m];
	return out as unknown as JWK;
}
