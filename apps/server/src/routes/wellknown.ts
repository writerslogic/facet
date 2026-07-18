// `/.well-known/*` documents served directly from the Worker (not the static-asset binding) so they
// carry correct content types, caching, and request-derived values (origin, expiry). Mounted before
// the SPA catch-all in `app.ts`. security.txt (RFC 9116) is the first document; trust/provenance
// documents (JWKS, DID) are added here as later phases land.

import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { buildSecurityTxt } from '../lib/security-txt.js';

export const wellKnownRoutes = new Hono<AppEnv>();

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
