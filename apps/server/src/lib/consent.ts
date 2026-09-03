// Signed consent — the authorization token that elevates a visitor above Tier 0. A consent record is
// a `facet-consent/1` SignedStatement over PII-FREE claims (the derived visitor hash, tier, window —
// never ip/ua/raw uid), signed by the deployment key. Elevation at ingest requires an active,
// signature-verifying record whose SIGNED claims are pinned to the deployment key AND bound to the
// exact ingest context. Two properties the design review flagged as CRITICAL and this module enforces:
//   1. Pin to the deployment key. `verifyStatement` alone only proves a statement is self-consistent
//      with its OWN embedded JWK, so anyone who can write a consent row could mint their own key and
//      forge a "valid" record. We additionally require proof.kid === the deployment key's kid; since
//      the embedded kid is already bound to the thumbprint of the embedded JWK, that equality means the
//      embedded key IS the deployment key (thumbprint collision-resistance). Forgery closed.
//   2. Bind the signed payload to the ingest context. The SIGNED claims — not the DB columns — are the
//      authorization: site_id, visitor_hash, tier, window_key, and iss must all equal the enforcement
//      context, so a genuine grant for (siteA, pseudonymous, week W) can never be replayed into a row
//      claiming (siteB, identified, week W'). Cross-site / cross-tier / cross-window replay closed.

import type { IdentityTier, SaltWindow } from '@facet/shared';
import {
	type SignedStatement,
	type SigningKey,
	signStatement,
	verifyStatement,
} from '@facet/trust';
import type { Env } from '../env.js';
import { deploymentDid, getSigningKey } from './signing.js';

export const CONSENT_STATEMENT_TYPE = 'facet-consent/1';

/** The PII-free claims signed into a consent record. Only the keyed one-way `visitor_hash` binds the
 * grant to an identity; no ip/ua/raw uid ever appears here. */
export interface ConsentClaims {
	iss: string;
	site_id: string;
	visitor_hash: string;
	tier: IdentityTier;
	salt_window: SaltWindow;
	window_key: string;
	external_user_id_present: boolean;
	gpc_at_grant: 0 | 1;
	granted_at: string;
	expires_at?: string;
}

/** The exact context a consent statement must be bound to for elevation to be authorized. */
export interface ConsentContext {
	siteId: string;
	visitorHash: string;
	tier: IdentityTier;
	windowKey: string;
	iss: string;
	kid: string;
}

/** Sign consent claims into a `facet-consent/1` statement with the deployment key. No new crypto — the
 * same `signStatement` used for MMR checkpoints and SCITT receipts. */
export function signConsent(
	key: SigningKey,
	claims: ConsentClaims,
	now: number,
): Promise<SignedStatement<ConsentClaims>> {
	return signStatement(CONSENT_STATEMENT_TYPE, claims, key, now);
}

/** The statement verifies against its own embedded key AND that key is the deployment key (kid
 * equality implies the same JWK thumbprint), issued by this deployment. Never sufficient on its own;
 * the caller must also bind every signed claim to the ingest context. */
async function verifyPinnedToDeployment(
	stmt: SignedStatement<ConsentClaims>,
	iss: string,
	kid: string,
): Promise<boolean> {
	const check = await verifyStatement(stmt, CONSENT_STATEMENT_TYPE);
	if (!check.valid) return false;
	// Pin to the deployment key (fixes self-embedded-JWK forgery).
	if (stmt.proof.kid !== kid) return false;
	return stmt.payload.iss === iss;
}

/** The security kernel. A consent statement authorizes elevation ONLY when its signature verifies,
 * it is pinned to the deployment key, and every security-relevant SIGNED claim equals the context.
 * Pure over its inputs so it can be tested directly against forged and replayed statements. */
export async function verifyConsentRecord(
	stmt: SignedStatement<ConsentClaims>,
	ctx: ConsentContext,
): Promise<boolean> {
	if (!(await verifyPinnedToDeployment(stmt, ctx.iss, ctx.kid))) return false;
	// Bind the signed payload to the ingest context (fixes cross-site/tier/window replay).
	const p = stmt.payload;
	return (
		p.site_id === ctx.siteId &&
		p.visitor_hash === ctx.visitorHash &&
		p.tier === ctx.tier &&
		p.window_key === ctx.windowKey
	);
}

/** A stored `statement` column is untrusted text: `JSON.parse` returns `null` for the literal `null`
 * and a scalar for a number, and `verifyStatement` destructures its argument — so a corrupt or
 * hand-written row would throw out of functions documented never to throw. Only an object can be a
 * statement. */
function parseStatement(raw: string): SignedStatement<ConsentClaims> | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return null;
		return parsed as SignedStatement<ConsentClaims>;
	} catch {
		return null;
	}
}

/** IMPORTANT: expiry is a SIGNED claim as well as a column, and the claim is the authorization. The
 * `expires_at` column alone would let a genuine, time-boxed statement be copied into a fresh row with
 * that column cleared and re-elevate past the window its subject agreed to. Unparsable fails closed. */
function claimsActiveAt(claims: ConsentClaims, now: number): boolean {
	if (claims.expires_at === undefined) return true;
	const at = Date.parse(claims.expires_at);
	return Number.isFinite(at) && at > now;
}

/** Parameters that identify the active consent row to look up at ingest time. */
export interface ConsentLookup {
	siteId: string;
	visitorHash: string;
	tier: IdentityTier;
	windowKey: string;
	now: number;
}

/** Find the active, non-expired consent record for a derived visitor and verify it against the
 * deployment key + ingest context. Returns the statement when elevation is authorized, else null
 * (the caller then keeps the event at Tier 0). Never throws. */
export async function findActiveConsent(
	env: Env,
	url: URL,
	lookup: ConsentLookup,
): Promise<SignedStatement<ConsentClaims> | null> {
	const loading = getSigningKey(env);
	if (!loading) return null; // no deployment key ⇒ nothing is verifiable ⇒ never elevate
	const key = await loading;
	const row = await env.DB.prepare(
		'SELECT statement FROM consent_records WHERE site_id = ? AND visitor_hash = ? AND tier = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY granted_at DESC LIMIT 1',
	)
		.bind(lookup.siteId, lookup.visitorHash, lookup.tier, lookup.now)
		.first<{ statement: string }>();
	if (!row) return null;
	const stmt = parseStatement(row.statement);
	if (!stmt) return null;
	// No did:web for this host ⇒ no `iss` any statement could have been issued under ⇒ nothing to
	// match, which is the same fail-closed answer this function gives to every other mismatch.
	const iss = deploymentDid(url);
	if (!iss) return null;
	const ctx: ConsentContext = {
		siteId: lookup.siteId,
		visitorHash: lookup.visitorHash,
		tier: lookup.tier,
		windowKey: lookup.windowKey,
		iss,
		kid: key.kid,
	};
	if (!(await verifyConsentRecord(stmt, ctx))) return null;
	return claimsActiveAt(stmt.payload, lookup.now) ? stmt : null;
}

/** A stored consent record, ready to insert. `externalUserId` is the raw site-supplied uid, persisted
 * at rest ONLY to support uid-scoped revocation (retention/erasure-bound, log-scrubbed like ip/uid). */
export interface ConsentRecordRow {
	id: string;
	siteId: string;
	visitorHash: string;
	tier: IdentityTier;
	externalUserId: string | null;
	saltWindow: SaltWindow;
	windowKey: string;
	gpcAtGrant: 0 | 1;
	grantedAt: number;
	expiresAt: number | null;
	statement: SignedStatement<ConsentClaims>;
}

/** Persist a signed consent record. */
export async function storeConsentRecord(env: Env, row: ConsentRecordRow): Promise<void> {
	await env.DB.prepare(
		'INSERT INTO consent_records (id, site_id, visitor_hash, tier, external_user_id, salt_window, window_key, gpc_at_grant, granted_at, expires_at, revoked_at, statement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
	)
		.bind(
			row.id,
			row.siteId,
			row.visitorHash,
			row.tier,
			row.externalUserId,
			row.saltWindow,
			row.windowKey,
			row.gpcAtGrant,
			row.grantedAt,
			row.expiresAt,
			JSON.stringify(row.statement),
		)
		.run();
}

/** Revoke consent by derived hash or, for Tier 2, by raw user id. Sets `revoked_at` on every matching
 * active row so a captured statement can never be re-elevated after revocation. Returns rows revoked. */
export async function revokeConsent(
	env: Env,
	params: {
		siteId: string;
		tier: IdentityTier;
		visitorHash?: string;
		externalUserId?: string;
		now: number;
	},
): Promise<number> {
	// One predicate picks both the column and the value: `??` would have kept an empty-string
	// externalUserId as the bound value while the truthiness test sent the clause to visitor_hash,
	// silently revoking nothing.
	const ident = params.externalUserId || params.visitorHash;
	if (!ident) {
		throw new Error('revokeConsent: externalUserId or visitorHash is required');
	}
	const clause = params.externalUserId ? 'external_user_id = ?' : 'visitor_hash = ?';
	const res = await env.DB.prepare(
		`UPDATE consent_records SET revoked_at = ? WHERE site_id = ? AND tier = ? AND ${clause} AND revoked_at IS NULL`,
	)
		.bind(params.now, params.siteId, params.tier, ident)
		.run();
	return res.meta.changes ?? 0;
}
