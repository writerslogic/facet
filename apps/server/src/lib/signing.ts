// Deployment signing key access for the Worker. The key is the optional `FACET_SIGNING_JWK` secret;
// when it is unset every signing/attestation feature is inert (like the anomaly webhook) so a plain
// deploy keeps working and the existing tests stay green. The loaded key is cached by its JWK string
// so we import it through Web Crypto once per isolate rather than on every request.

import { type SigningKey, loadSigningKey } from '@facet/trust';
import type { Env } from '../env.js';

const cache = new Map<string, Promise<SigningKey>>();

/** Load the deployment signing key, or return null when signing is not configured. */
export function getSigningKey(env: Env): Promise<SigningKey> | null {
	const jwk = env.FACET_SIGNING_JWK;
	if (!jwk) return null;
	let loading = cache.get(jwk);
	if (!loading) {
		loading = loadSigningKey(jwk);
		cache.set(jwk, loading);
	}
	return loading;
}

/** True when the deployment has a signing key configured. */
export function signingEnabled(env: Env): boolean {
	return Boolean(env.FACET_SIGNING_JWK);
}

/** The URL of this deployment's JWKS document, derived from the request origin. */
export function jwksUrl(origin: string): string {
	return `${origin}/.well-known/jwks.json`;
}
