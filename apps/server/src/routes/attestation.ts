// Deployment attestation endpoints, signed by the deployment DID with eddsa-jcs-2022 (Data Integrity)
// or the deployment key (RATS EAT). Public — statements about the deployment, no PII, no visitor named.
//   GET /api/attestation/privacy   — a PrivacyAttestationCredential that references the RATS evidence.
//   GET /api/attestation/evidence  — a RATS process-evidence EAT (software attestation only; optional
//                                    ?nonce=<verifier nonce> for freshness).
// Both require an Ed25519 signing key (Data Integrity is Ed25519-only); 501 when unconfigured.

import {
	EAT_PROCESS_PROFILE,
	buildPrivacyAttestationCredential,
	eatNonceError,
	issueCredential,
	signProcessEvidence,
	verificationMethodId,
} from '@facet/trust';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { buildProcessEvidence, deploymentDescriptor } from '../lib/attestation.js';
import { privacyDpvClaims } from '../lib/dpv.js';
import { ApiError } from '../lib/http.js';
import {
	deploymentDid,
	ed25519KeyErrorCode,
	getSigningKey,
	loadEd25519Key,
} from '../lib/signing.js';

export const attestationRoutes = new Hono<AppEnv>();

attestationRoutes.get('/privacy', async (c) => {
	const r = await loadEd25519Key(c.env);
	if ('error' in r) {
		return c.json(
			{
				error: ed25519KeyErrorCode(r.error, {
					unconfigured: 'signing_unavailable',
					notEd25519: 'attestation_requires_ed25519',
				}),
			},
			501,
		);
	}
	const key = r.key;
	const now = Date.now();
	const did = deploymentDid(new URL(c.req.url));
	const created = new Date(now).toISOString();
	// Sign the RATS evidence so the credential can reference its content-ref digest.
	const evidence = await signProcessEvidence(await buildProcessEvidence(c.env), key, { now });
	const doc = buildPrivacyAttestationCredential({
		did,
		created,
		deployment: await deploymentDescriptor(c.env),
		dpv: privacyDpvClaims(c.env),
		evidence: {
			profile: EAT_PROCESS_PROFILE,
			contentRef: evidence.payload['content-ref'],
		},
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

attestationRoutes.get('/evidence', async (c) => {
	const loading = getSigningKey(c.env);
	if (!loading) return c.json({ error: 'signing_unavailable' }, 501);
	const key = await loading;
	// The one request-derived value on either attestation route, and it is copied verbatim into a
	// signed claim, so it is bounded before the key is ever used: RFC 9711 sizes a JSON `eat_nonce` at
	// 8..88 bytes and a verifier applying that CDDL rejects anything else. Unchecked, a caller could
	// have the deployment sign an EAT no verifier would accept and never learn why. `bad_request` with
	// the reason, matching the other public router's shape — the bound is a published property of the
	// caller's own input, so stating it reveals nothing about this deployment.
	const nonce = c.req.query('nonce') ?? undefined;
	if (nonce !== undefined) {
		const bad = eatNonceError(nonce);
		if (bad) throw new ApiError('bad_request', 400, bad);
	}
	const eat = await signProcessEvidence(await buildProcessEvidence(c.env), key, {
		now: Date.now(),
		nonce,
	});
	return c.json(eat, 200, { 'content-type': 'application/json' });
});
