// Self-contained signed-export envelope: a stats export plus a detached-JWS proof over the canonical
// (RFC 8785) bytes of its payload, with the public JWK embedded so it verifies fully offline. The
// `jwksUrl` lets a verifier additionally confirm the embedded key matches the deployment's published
// key set (online trust). Shared by @facet/server (issue) and the CLI (verify).

import type { JWK } from 'jose';
import { canonicalizeBytes } from './canonicalize.js';
import { signDetachedJws, verifyDetachedProof } from './jws.js';
import { type SigningAlg, type SigningKey, toPublicJwkFields } from './keys.js';

/** Envelope format identifier (versioned so future changes are detectable). */
export const SIGNED_EXPORT_TYPE = 'facet-signed-export/1' as const;

export interface SignedExportProof {
	type: 'DetachedJWS';
	alg: SigningAlg;
	kid: string;
	/** Detached JWS (`<protected>..<signature>`) over `canonicalizeBytes(payload)`. */
	jws: string;
	/** Public JWK, embedded for offline verification. */
	publicJwk: JWK;
	/** Where the authoritative JWKS lives, for online key cross-checking. */
	jwksUrl?: string;
	/** ISO 8601 issuance time. */
	created: string;
}

export interface SignedExport {
	facet: typeof SIGNED_EXPORT_TYPE;
	payload: unknown;
	proof: SignedExportProof;
}

export interface SignExportOptions {
	jwksUrl?: string;
	/** Issuance time in ms (injectable for deterministic tests). */
	now: number;
}

/** Build a signed-export envelope around `payload`, signed by `key`. */
export async function signExport(
	payload: unknown,
	key: SigningKey,
	opts: SignExportOptions,
): Promise<SignedExport> {
	const jws = await signDetachedJws(canonicalizeBytes(payload), key);
	return {
		facet: SIGNED_EXPORT_TYPE,
		payload,
		proof: {
			type: 'DetachedJWS',
			alg: key.alg,
			kid: key.kid,
			jws,
			publicJwk: toPublicJwkFields(key.publicJwk),
			jwksUrl: opts.jwksUrl,
			created: new Date(opts.now).toISOString(),
		},
	};
}

export interface SignedExportVerification {
	valid: boolean;
	kid: string;
	alg: SigningAlg;
	jwksUrl?: string;
	/** Present when invalid: why verification failed. */
	reason?: string;
}

/** Verify a signed-export envelope offline against its embedded public JWK. Fails closed on a
 * null/non-object envelope rather than throwing on the destructure. */
export async function verifySignedExport(env: SignedExport): Promise<SignedExportVerification> {
	if (env == null || typeof env !== 'object') {
		return {
			valid: false,
			kid: '',
			alg: 'EdDSA',
			reason: 'malformed envelope',
		};
	}
	const { proof, payload } = env;
	const kid = proof?.kid ?? '';
	const alg = proof?.alg ?? 'EdDSA';
	const jwksUrl = proof?.jwksUrl;
	const fail = (reason: string): SignedExportVerification => ({
		valid: false,
		kid,
		alg,
		jwksUrl,
		reason,
	});

	if (env.facet !== SIGNED_EXPORT_TYPE) return fail('unrecognized envelope type');
	const check = await verifyDetachedProof(proof, payload);
	return check.ok
		? { valid: true, kid, alg, jwksUrl }
		: fail(check.reason ?? 'verification failed');
}
