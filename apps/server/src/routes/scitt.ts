// SCITT endpoints. POST /api/scitt/attestation (admin) wraps the deployment's PrivacyAttestation as a
// SCITT Signed Statement, registers it with the local Transparency-Service double (and an external
// service if SCITT_URL is set), and returns the Signed Statement + Receipt. POST /api/scitt/register
// (admin) registers an arbitrary Signed Statement. Requires an Ed25519 signing key.

import {
	type SignedStatement,
	buildPrivacyAttestationCredential,
	issueCredential,
	signSignedStatement,
	verificationMethodId,
} from '@facet/trust';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Env } from '../env.js';
import { deploymentDescriptor } from '../lib/attestation.js';
import { requireAdmin } from '../lib/auth.js';
import { privacyDpvClaims } from '../lib/dpv.js';
import { ApiError } from '../lib/http.js';
import { createLogger } from '../lib/log.js';
import { type ExternalRegistration, registerExternal, registerLocal } from '../lib/scitt.js';
import { deploymentDid, ed25519KeyErrorCode, loadEd25519Key } from '../lib/signing.js';

const log = createLogger({ route: 'scitt' });

/** Largest body `/register` may carry. The global `bodyLimit` is path-scoped to `/api/collect`, so
 * without this the body is canonicalized, hashed and written to an append-only log unbounded.
 * Generous against the statement `/attestation` itself emits: a backstop, not a wire schema. */
const SCITT_MAX_BODY_BYTES = 16_384;

/**
 * Register with the external Transparency Service, best-effort: the local log entry is already
 * committed and durable, so a broken or unreachable external service must not fail the request.
 * Logged rather than swallowed — a bare `.catch(() => null)` makes a failed external registration
 * indistinguishable from `SCITT_URL` being unset, which is the same `null` the caller returns.
 */
async function tryRegisterExternal(
	env: Env,
	statement: SignedStatement,
): Promise<ExternalRegistration | null> {
	try {
		return await registerExternal(env, statement);
	} catch (err) {
		log.error('scitt_external_register_failed', err);
		return null;
	}
}

export const scittRoutes = new Hono<AppEnv>();

scittRoutes.post('/attestation', requireAdmin, async (c) => {
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
	if (!did) return c.json({ error: 'did_unavailable' }, 501);
	const created = new Date(now).toISOString();
	const vc = await issueCredential(
		buildPrivacyAttestationCredential({
			did,
			created,
			deployment: await deploymentDescriptor(c.env),
			dpv: privacyDpvClaims(c.env),
		}),
		key,
		{ verificationMethod: verificationMethodId(did, key.kid), created },
	);
	const format = c.req.query('format') === 'cose' ? 'cose' : 'jws';
	const statement = await signSignedStatement(vc, key, now);
	const receipt = await registerLocal(c.env, statement, now, format);
	const external = await tryRegisterExternal(c.env, statement);
	return c.json({ statement, receipt, external });
});

scittRoutes.post(
	'/register',
	requireAdmin,
	bodyLimit({
		maxSize: SCITT_MAX_BODY_BYTES,
		onError: () => {
			throw new ApiError('payload_too_large', 413);
		},
	}),
	async (c) => {
		const now = Date.now();
		const parsed: unknown = await c.req.json().catch(() => null);
		if (!parsed || typeof parsed !== 'object' || !('proof' in parsed)) {
			throw new ApiError('validation_failed', 400, 'expected a signed statement in the body');
		}
		const statement = parsed as SignedStatement;
		const receipt = await registerLocal(c.env, statement, now);
		if (!receipt) return c.json({ error: 'signing_unavailable' }, 501);
		const external = await tryRegisterExternal(c.env, statement);
		return c.json({ receipt, external });
	},
);
