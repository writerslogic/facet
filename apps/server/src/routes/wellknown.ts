// `/.well-known/*` documents served directly from the Worker (not the static-asset binding) so they
// carry correct content types, caching, and request-derived values (origin, expiry). Mounted before
// the SPA catch-all in `app.ts`. security.txt (RFC 9116) is the first document; trust/provenance
// documents (JWKS, DID) are added here as later phases land.

import {
	buildDidConfiguration,
	buildDidDocument,
	didWebFromHost,
	issueDomainLinkageCredential,
	toJwks,
} from '@facet/trust';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { deploymentDescriptor } from '../lib/attestation.js';
import { privacyDpvClaims } from '../lib/dpv.js';
import { buildSecurityTxt } from '../lib/security-txt.js';
import { getSigningKey } from '../lib/signing.js';

export const wellKnownRoutes = new Hono<AppEnv>();

// Machine-readable privacy manifest (W3C DPV terms). Unsigned and always available — it describes the
// deployment's processing/purpose/legal-basis + privacy properties. The same DPV claims are embedded
// (and signed) in the PrivacyAttestationCredential at /api/attestation/privacy.
wellKnownRoutes.get('/facet-privacy.json', async (c) => {
	return c.json(
		{
			deployment: await deploymentDescriptor(c.env),
			dpv: privacyDpvClaims(),
			attestation: '/api/attestation/privacy',
		},
		200,
		{
			'content-type': 'application/json',
			'cache-control': 'public, max-age=3600',
		},
	);
});

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

// did:web DID document. The deployment DID is `did:web:<host>`; its verification method is the JWKS
// Ed25519 key as a Multikey. Requires an Ed25519 signing key (Data Integrity is Ed25519-only); 404
// when signing is unconfigured or the key is ECDSA.
wellKnownRoutes.get('/did.json', async (c) => {
	const loading = getSigningKey(c.env);
	if (!loading) return c.json({ error: 'not_configured' }, 404);
	const key = await loading;
	if (key.alg !== 'EdDSA') return c.json({ error: 'did_requires_ed25519' }, 404);
	const did = didWebFromHost(new URL(c.req.url).host);
	return c.json(buildDidDocument(did, key.kid, key.publicJwk), 200, {
		'content-type': 'application/did+json',
		'cache-control': 'public, max-age=3600',
	});
});

// DIF Well-Known DID Configuration: a Domain Linkage Credential binding the origin to the DID,
// signed by the deployment key (eddsa-jcs-2022). Same Ed25519 requirement as did.json.
wellKnownRoutes.get('/did-configuration.json', async (c) => {
	const loading = getSigningKey(c.env);
	if (!loading) return c.json({ error: 'not_configured' }, 404);
	const key = await loading;
	if (key.alg !== 'EdDSA') return c.json({ error: 'did_requires_ed25519' }, 404);
	const url = new URL(c.req.url);
	const did = didWebFromHost(url.host);
	const credential = await issueDomainLinkageCredential({
		did,
		origin: url.origin,
		key,
		created: new Date().toISOString(),
	});
	return c.json(buildDidConfiguration([credential]), 200, {
		'content-type': 'application/json',
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
