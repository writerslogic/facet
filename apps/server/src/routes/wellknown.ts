// `/.well-known/*` documents served directly from the Worker (not the static-asset binding) so they
// carry correct content types, caching, and request-derived values (origin, expiry). Mounted before
// the SPA catch-all in `app.ts`. security.txt (RFC 9116) is the first document; trust/provenance
// documents (JWKS, DID) are added here as later phases land.

import { toJwks } from '@facet/trust';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { buildSecurityTxt } from '../lib/security-txt.js';
import { getSigningKey } from '../lib/signing.js';

export const wellKnownRoutes = new Hono<AppEnv>();

// Public JWKS: the deployment's signing public key(s), referenced by the DID doc and used by
// verifiers of signed exports/credentials. Empty key set when signing is unconfigured.
wellKnownRoutes.get('/jwks.json', async (c) => {
	const loading = getSigningKey(c.env);
	const keys = loading ? [(await loading).publicJwk] : [];
	return c.json(toJwks(keys), 200, {
		'content-type': 'application/jwk-set+json',
		'cache-control': 'public, max-age=3600',
	});
});

// RFC 9116 security.txt. Text is stable except for the request-relative Expires, so a modest cache is safe.
wellKnownRoutes.get('/security.txt', (c) => {
	const origin = new URL(c.req.url).origin;
	const body = buildSecurityTxt({
		origin,
		contact: c.env.FACET_SECURITY_CONTACT,
		policy: c.env.FACET_SECURITY_POLICY,
		now: Date.now(),
	});
	return c.body(body, 200, {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'public, max-age=86400',
	});
});
