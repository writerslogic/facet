// SCITT endpoints. POST /api/scitt/attestation (admin) wraps the deployment's PrivacyAttestation as a
// SCITT Signed Statement, registers it with the local Transparency-Service double (and an external
// service if SCITT_URL is set), and returns the Signed Statement + Receipt. POST /api/scitt/register
// (admin) registers an arbitrary Signed Statement. Requires an Ed25519 signing key.

import {
	buildPrivacyAttestationCredential,
	issueCredential,
	signSignedStatement,
	verificationMethodId,
} from '@facet/trust';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { deploymentDescriptor } from '../lib/attestation.js';
import { requireAdmin } from '../lib/auth.js';
import { privacyDpvClaims } from '../lib/dpv.js';
import { registerExternal, registerLocal } from '../lib/scitt.js';
import { deploymentDid, loadEd25519Key } from '../lib/signing.js';

export const scittRoutes = new Hono<AppEnv>();

scittRoutes.post('/attestation', requireAdmin, async (c) => {
	const r = await loadEd25519Key(c.env);
	if ('error' in r) {
		return c.json(
			{
				error:
					r.error === 'unconfigured'
						? 'signing_unavailable'
						: 'attestation_requires_ed25519',
			},
			501,
		);
	}
	const key = r.key;
	const now = Date.now();
	const did = deploymentDid(new URL(c.req.url));
	const created = new Date(now).toISOString();
	const vc = await issueCredential(
		buildPrivacyAttestationCredential({
			did,
			created,
			deployment: await deploymentDescriptor(c.env),
			dpv: privacyDpvClaims(),
		}),
		key,
		{ verificationMethod: verificationMethodId(did, key.kid), created },
	);
	const statement = await signSignedStatement(vc, key, now);
	const receipt = await registerLocal(c.env, statement, now);
	const external = await registerExternal(c.env, statement).catch(() => null);
	return c.json({ statement, receipt, external });
});

scittRoutes.post('/register', requireAdmin, async (c) => {
	const now = Date.now();
	const statement = await c.req.json().catch(() => null);
	if (!statement || typeof statement !== 'object' || !('proof' in statement)) {
		return c.json({ error: 'expected a signed statement in the body' }, 400);
	}
	const receipt = await registerLocal(c.env, statement, now);
	if (!receipt) return c.json({ error: 'signing_unavailable' }, 501);
	const external = await registerExternal(c.env, statement).catch(() => null);
	return c.json({ receipt, external });
});
