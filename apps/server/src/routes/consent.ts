// Consent endpoints (API key). A site's own backend records the visitor's real consent (collected via
// its own CMP) so ingest may elevate that visitor above Tier 0. The site_id is ALWAYS taken from the
// API key, never the body, so a key for site A can neither grant nor revoke consent for site B. GPC is
// checked FIRST: a GPC request is refused (202, nothing written) — a visitor asserting opt-out can
// never be elevated, even by an explicit grant. Elevation requires a deployment signing key (501
// without one). The raw ip/ua/user_id are transient — used only to derive the same per-window hash the
// ingest path will, and never stored (only the derived hash + a boolean uid-present flag are signed).

import { ConsentGrantSchema, ConsentRevokeSchema } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireApiKey } from '../lib/auth.js';
import {
	type ConsentClaims,
	revokeConsent,
	signConsent,
	storeConsentRecord,
} from '../lib/consent.js';
import { isGpcOptOut } from '../lib/gpc.js';
import { validationErrorHook } from '../lib/http.js';
import {
	deriveVisitorHash,
	getScopedSalt,
	resolvePolicy,
	windowEndMs,
	windowKey,
} from '../lib/identity.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp } from '../lib/request-meta.js';
import { deploymentDid, getSigningKey } from '../lib/signing.js';

export const consentRoutes = new Hono<AppEnv>();

consentRoutes.post(
	'/',
	requireApiKey,
	rateLimit((c) => `consent:${c.get('siteId')}`),
	vValidator('json', ConsentGrantSchema, validationErrorHook),
	async (c) => {
		// GPC first: never mint a consent record for a visitor asserting opt-out.
		if (isGpcOptOut(c.req.raw)) {
			return c.body(null, 202);
		}
		const loading = getSigningKey(c.env);
		if (!loading) {
			return c.json({ error: 'identity_signing_unconfigured' }, 501);
		}
		const siteId = c.get('siteId'); // from the API key, NEVER the body
		const body = c.req.valid('json');
		const policy = await resolvePolicy(c.env, siteId);
		if (policy.tier === 'anonymous') {
			return c.json({ error: 'site_not_elevated' }, 400);
		}
		if (body.tier !== policy.tier) {
			return c.json({ error: 'tier_mismatch' }, 400);
		}
		const now = Date.now();
		const wk = windowKey(policy.window, now);
		const scope = `${siteId}:${policy.window}:${wk}`;
		const salt = await getScopedSalt(
			c.env,
			scope,
			policy.window,
			windowEndMs(policy.window, now),
			now,
		);
		const uid = policy.tier === 'identified' ? (body.user_id ?? null) : null;
		const ip = body.ip ?? clientIp(c.req.raw);
		const ua = body.user_agent ?? c.req.header('user-agent') ?? '';
		const vh = await deriveVisitorHash(policy.tier, { ip, ua, uid }, salt, siteId);
		const key = await loading;
		const claims: ConsentClaims = {
			iss: deploymentDid(new URL(c.req.url)),
			site_id: siteId,
			visitor_hash: vh,
			tier: policy.tier,
			salt_window: policy.window,
			window_key: wk,
			external_user_id_present: uid !== null,
			gpc_at_grant: 0,
			granted_at: new Date(now).toISOString(),
			...(body.expires_at ? { expires_at: new Date(body.expires_at).toISOString() } : {}),
		};
		const statement = await signConsent(key, claims, now);
		await storeConsentRecord(c.env, {
			id: crypto.randomUUID(),
			siteId,
			visitorHash: vh,
			tier: policy.tier,
			externalUserId: uid,
			saltWindow: policy.window,
			windowKey: wk,
			gpcAtGrant: 0,
			grantedAt: now,
			expiresAt: body.expires_at ?? null,
			statement,
		});
		// Return the signed statement for the caller's audit trail (it is PII-free).
		return c.json({ consent: statement }, 201);
	},
);

consentRoutes.delete(
	'/',
	requireApiKey,
	rateLimit((c) => `consent:${c.get('siteId')}`),
	vValidator('json', ConsentRevokeSchema, validationErrorHook),
	async (c) => {
		const siteId = c.get('siteId');
		const body = c.req.valid('json');
		const now = Date.now();
		// Tier 2: revoke every row for the raw uid, so a captured statement can't re-elevate.
		if (body.user_id) {
			const revoked = await revokeConsent(c.env, {
				siteId,
				tier: body.tier,
				externalUserId: body.user_id,
				now,
			});
			return c.json({ revoked });
		}
		// Tier 1: derive the current-window hash from ip/ua and revoke by it.
		const policy = await resolvePolicy(c.env, siteId);
		if (policy.tier === 'anonymous' || !body.ip) {
			return c.json({ revoked: 0 });
		}
		const wk = windowKey(policy.window, now);
		const scope = `${siteId}:${policy.window}:${wk}`;
		const salt = await getScopedSalt(
			c.env,
			scope,
			policy.window,
			windowEndMs(policy.window, now),
			now,
		);
		const vh = await deriveVisitorHash(
			policy.tier,
			{ ip: body.ip, ua: body.user_agent ?? '', uid: null },
			salt,
			siteId,
		);
		const revoked = await revokeConsent(c.env, {
			siteId,
			tier: body.tier,
			visitorHash: vh,
			now,
		});
		return c.json({ revoked });
	},
);
