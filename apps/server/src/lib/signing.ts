// Deployment signing key access for the Worker. The key is the optional `FACET_SIGNING_JWK` secret;
// when it is unset every signing/attestation feature is inert (like the anomaly webhook) so a plain
// deploy keeps working and the existing tests stay green. The loaded key is cached by its JWK string
// so we import it through Web Crypto once per isolate rather than on every request.

import { type SigningKey, didWebFromHost, didWebHostError, loadSigningKey } from '@facet/trust';
import type { Env } from '../env.js';

const cache = new Map<string, Promise<SigningKey>>();

/** Load the deployment signing key, or return null when signing is not configured. */
export function getSigningKey(env: Env): Promise<SigningKey> | null {
	const jwk = env.FACET_SIGNING_JWK;
	if (!jwk) return null;
	let loading = cache.get(jwk);
	if (!loading) {
		loading = loadSigningKey(jwk);
		// IMPORTANT: the cached promise outlives the request that created it, so a malformed JWK's
		// rejection would surface as an unhandled rejection under any caller that only null-checks.
		loading.catch(() => {});
		cache.set(jwk, loading);
	}
	return loading;
}

/** The deployment DID (`did:web:<host>`) derived from a request URL — the single place this mapping
 * is defined, so a future public-origin override changes here only.
 *
 * Null when the request host cannot BE a did:web (an IP literal, or a character outside the DID Core
 * idchar set): a deployment reached that way has no deployment DID, and there is nothing honest to put
 * in the `issuer` of a credential it signs. Null rather than a throw because the two kinds of caller
 * want opposite things and `string | null` makes the compiler ask each one which it is — an issuing
 * route must refuse to sign, while the never-throw consent verifiers want the same answer they give
 * for any other mismatch: no statement this deployment could have issued matches, so nothing is
 * authorized. */
export function deploymentDid(url: URL): string | null {
	return didWebHostError(url.host) ? null : didWebFromHost(url.host);
}

/** Why an Ed25519 key was unavailable. */
export type Ed25519KeyError = 'unconfigured' | 'not_ed25519';

/** Either a loaded key, or why it is unavailable. */
export type Ed25519KeyResult = { key: SigningKey } | { error: Ed25519KeyError };

/** Map an {@link Ed25519KeyError} to a caller-chosen error code — the single place the
 * "no key configured" vs "key is ECDSA" distinction is turned into a response label. */
export function ed25519KeyErrorCode(
	error: Ed25519KeyError,
	labels: { unconfigured: string; notEd25519: string },
): string {
	return error === 'unconfigured' ? labels.unconfigured : labels.notEd25519;
}

/** Load the deployment signing key and require Ed25519 (needed by Data Integrity, did:web, and the
 * attestation/report/DID endpoints). Distinguishes "no key configured" from "key is ECDSA" so each
 * caller maps the outcome to its own status/error while the Ed25519 policy lives in one place. */
export async function loadEd25519Key(env: Env): Promise<Ed25519KeyResult> {
	const loading = getSigningKey(env);
	if (!loading) return { error: 'unconfigured' };
	const key = await loading;
	if (key.alg !== 'EdDSA') return { error: 'not_ed25519' };
	return { key };
}

/** The URL of this deployment's JWKS document, derived from the request origin. */
export function jwksUrl(origin: string): string {
	return `${origin}/.well-known/jwks.json`;
}
