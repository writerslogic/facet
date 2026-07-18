// Deployment key handling, Workers-native. Keys are Ed25519 (preferred) or ECDSA P-256, all handled
// through Web Crypto via `jose` so they run unchanged in workerd. The private key lives only as a
// Worker secret (a JWK string); the public half is published as a JWK/JWKS and referenced by the DID
// document. `kid` is the RFC 7638 JWK thumbprint so it is stable and self-describing.

import { type JWK, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from 'jose';

/** JWS `alg` values this deployment supports. Ed25519 is preferred; P-256 is the ECDSA fallback. */
export type SigningAlg = 'EdDSA' | 'ES256';

/** A loaded deployment signing key: the private CryptoKey plus its published public JWK and `kid`. */
export interface SigningKey {
	alg: SigningAlg;
	kid: string;
	/** Non-extractable-friendly CryptoKey used for signing. */
	privateKey: CryptoKey;
	/** Public JWK (with `kid`/`alg`/`use`) suitable for a JWKS. */
	publicJwk: JWK;
}

/** Map a JWK to the `alg` we sign with, rejecting unsupported curves. */
function algForJwk(jwk: JWK): SigningAlg {
	if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'EdDSA';
	if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
	throw new Error(`unsupported key type for signing: kty=${jwk.kty} crv=${jwk.crv}`);
}

/** Public-JWK view of a private JWK: drop the private scalar `d` and stamp use/alg/kid. */
async function toPublicJwk(privateJwk: JWK, alg: SigningAlg): Promise<JWK> {
	const { d: D, ...pub } = privateJwk;
	const kid = await calculateJwkThumbprint(pub);
	return { ...pub, alg, use: 'sig', kid };
}

/** Load the deployment signing key from a JWK string (the `FACET_SIGNING_JWK` Worker secret). */
export async function loadSigningKey(jwkJson: string): Promise<SigningKey> {
	let privateJwk: JWK;
	try {
		privateJwk = JSON.parse(jwkJson) as JWK;
	} catch {
		throw new Error('FACET_SIGNING_JWK is not valid JSON');
	}
	if (!privateJwk.d) throw new Error('FACET_SIGNING_JWK must be a private JWK (missing `d`)');
	const alg = algForJwk(privateJwk);
	const key = await importJWK(privateJwk, alg);
	if (!(key instanceof CryptoKey)) throw new Error('signing key did not import as a CryptoKey');
	const publicJwk = await toPublicJwk(privateJwk, alg);
	return { alg, kid: publicJwk.kid as string, privateKey: key, publicJwk };
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

/** Import a public JWK for verification, inferring the `alg`. */
export async function importPublicJwk(jwk: JWK): Promise<{ key: CryptoKey; alg: SigningAlg }> {
	const alg = jwk.alg === 'ES256' || jwk.alg === 'EdDSA' ? jwk.alg : algForJwk(jwk);
	const key = await importJWK(jwk, alg);
	if (!(key instanceof CryptoKey)) throw new Error('public key did not import as a CryptoKey');
	return { key, alg };
}
