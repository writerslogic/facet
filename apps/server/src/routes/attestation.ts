// Deployment attestation endpoints. GET /api/attestation/privacy issues a PrivacyAttestationCredential
// about this deployment (build/config/privacy properties), signed by the deployment DID with
// eddsa-jcs-2022. Public — it is a statement about the deployment, contains no PII, and names no
// visitor. Requires an Ed25519 signing key (Data Integrity is Ed25519-only); 501 when unconfigured.

import {
	buildPrivacyAttestationCredential,
	didWebFromHost,
	issueCredential,
	verificationMethodId,
} from '@facet/trust';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { deploymentDescriptor } from '../lib/attestation.js';
import { privacyDpvClaims } from '../lib/dpv.js';
import { getSigningKey } from '../lib/signing.js';

export const attestationRoutes = new Hono<AppEnv>();

attestationRoutes.get('/privacy', async (c) => {
	const loading = getSigningKey(c.env);
	if (!loading) return c.json({ error: 'signing_unavailable' }, 501);
	const key = await loading;
	if (key.alg !== 'EdDSA') return c.json({ error: 'attestation_requires_ed25519' }, 501);
	const did = didWebFromHost(new URL(c.req.url).host);
	const created = new Date().toISOString();
	const doc = buildPrivacyAttestationCredential({
		did,
		created,
		deployment: await deploymentDescriptor(c.env),
		dpv: privacyDpvClaims(),
	});
	const vc = await issueCredential(doc, key, {
		verificationMethod: verificationMethodId(did, key.kid),
		created,
	});
	return c.json(vc, 200, {
		'content-type': 'application/vc+json',
		'cache-control': 'public, max-age=300',
	});
});
