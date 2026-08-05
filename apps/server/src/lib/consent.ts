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
//
// The optional CRM extension reads this module for the SAME reason and under the same rules: a
// contact's `external_user_id` is only an index into `consent_records`, and the visitor hash it
// resolves to comes out of a verified statement (`findLinkedVisitorHashes`), never out of a column.
// That is what makes the CRM→analytics join consent-gated by construction rather than by convention.
// A company rollup is the same function over many uids at once, not a second route around it.

import type { IdentityTier, SaltWindow } from '@facet/shared';
import {
	type SignedStatement,
	type SigningKey,
	signStatement,
	verifyStatement,
} from '@facet/trust';
import type { Env } from '../env.js';
import { chunked } from './constants.js';
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

/** Property 1 alone: the statement verifies against its own embedded key AND that key is the
 * deployment key (kid equality ⇒ same JWK thumbprint), issued by this deployment. Split out because
 * the two callers bind DIFFERENT things afterwards — ingest already knows the hash and window it
 * expects, while the CRM link derives the hash FROM the statement — so only the pinning is shared.
 * Never a sufficient check on its own; every caller must add its own claim-to-context equalities. */
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
	let stmt: SignedStatement<ConsentClaims>;
	try {
		stmt = JSON.parse(row.statement) as SignedStatement<ConsentClaims>;
	} catch {
		return null;
	}
	const ctx: ConsentContext = {
		siteId: lookup.siteId,
		visitorHash: lookup.visitorHash,
		tier: lookup.tier,
		windowKey: lookup.windowKey,
		iss: deploymentDid(url),
		kid: key.kid,
	};
	return (await verifyConsentRecord(stmt, ctx)) ? stmt : null;
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

/**
 * The ONE bridge from a CRM contact to analytics. Resolve a site's opaque `external_user_id` to the
 * visitor hashes it is currently allowed to be linked to — one per salt window with a live grant.
 *
 * The authorization is the SIGNED statement, never the row. `external_user_id` is only an index into
 * `consent_records`; what comes back is `payload.visitor_hash`, taken from claims that verified
 * against the deployment key and assert `tier: identified` for THIS site. So a row hand-written into
 * the table with an attacker-chosen `visitor_hash` column links nothing, and a genuine grant for
 * another site cannot be replayed into this one.
 *
 * Returns an empty array — never throws, never partially fails — when the deployment has no signing
 * key, when there is no active grant, or when a stored statement fails to verify. An empty result is
 * the correct answer to "what may I link?", and it is also what retention produces on its own: once
 * `enforceRetention` purges the consent record, this returns nothing and the contact silently stops
 * being connected to any analytics. Nothing caches the result, so that severing needs no cleanup.
 */
export async function findLinkedVisitorHashes(
	env: Env,
	url: URL,
	lookup: { siteId: string; externalUserId: string; now: number },
): Promise<string[]> {
	const byUid = await findLinkedVisitorHashesForMany(env, url, {
		siteId: lookup.siteId,
		externalUserIds: [lookup.externalUserId],
		now: lookup.now,
	});
	return byUid.get(lookup.externalUserId) ?? [];
}

/**
 * The same bridge for a SET of `external_user_id`s, keyed by uid — what a company rollup needs to sum
 * its contacts' activity without asking the database once per contact.
 *
 * It is the single implementation, with `findLinkedVisitorHashes` delegating to it, deliberately:
 * a second copy of this loop is a second place for the claims-not-columns rule to be got wrong, and
 * the one that summed many people at once would be the worse place to get it wrong. Every uid absent
 * from the returned map has nothing authorizing a link, which is indistinguishable — and should be —
 * from having no consent record at all.
 *
 * The `external_user_id` COLUMN groups the results and the SIGNED claims authorize them: the column
 * says which contact asked, the statement says what they may see. A row whose column names one uid
 * while pointing at another person's hash still has to survive the signature check, which is what
 * stops the grouping key from becoming an authorization key.
 *
 * The uid list is CHUNKED across statements rather than bound in one. D1 rejects any query carrying
 * more than 100 bound parameters, and this one spends two of them on `site_id` and `now` — so a
 * company of 99 linkable contacts asked for 101 and the statement was refused outright. That is a
 * hard failure, not a slow one, and it lands on exactly the largest account rather than on the small
 * ones a test would reach for.
 */
export async function findLinkedVisitorHashesForMany(
	env: Env,
	url: URL,
	lookup: { siteId: string; externalUserIds: string[]; now: number },
): Promise<Map<string, string[]>> {
	const byUid = new Map<string, string[]>();
	if (lookup.externalUserIds.length === 0) return byUid;
	const loading = getSigningKey(env);
	if (!loading) return byUid;
	const key = await loading;
	const iss = deploymentDid(url);
	const seen = new Map<string, Set<string>>();
	for (const batch of chunked(lookup.externalUserIds)) {
		const placeholders = batch.map(() => '?').join(', ');
		const { results } = await env.DB.prepare(
			`SELECT external_user_id, statement FROM consent_records WHERE site_id = ? AND external_user_id IN (${placeholders}) AND tier = 'identified' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
		)
			.bind(lookup.siteId, ...batch, lookup.now)
			.all<{ external_user_id: string; statement: string }>();
		for (const row of results ?? []) {
			let stmt: SignedStatement<ConsentClaims>;
			try {
				stmt = JSON.parse(row.statement) as SignedStatement<ConsentClaims>;
			} catch {
				continue;
			}
			if (!(await verifyPinnedToDeployment(stmt, iss, key.kid))) continue;
			const p = stmt.payload;
			// The claims, not the columns: this grant must be for this site, at the identified tier,
			// and must actually have been made against an external user id rather than an ip/ua
			// pseudonym.
			if (p.site_id !== lookup.siteId) continue;
			if (p.tier !== 'identified') continue;
			if (!p.external_user_id_present) continue;
			const hashes = seen.get(row.external_user_id) ?? new Set<string>();
			hashes.add(p.visitor_hash);
			seen.set(row.external_user_id, hashes);
		}
	}
	for (const [uid, hashes] of seen) {
		byUid.set(uid, [...hashes]);
	}
	return byUid;
}

/**
 * Erase every consent record for a raw user id — DELETE, not `revoked_at`. Used when a contact is
 * deleted: revocation would stop future elevation but leave a row still holding that person's raw
 * `external_user_id`, which is exactly the data an erasure request is about. Returns rows erased.
 */
export async function eraseConsentByExternalUserId(
	env: Env,
	params: { siteId: string; externalUserId: string },
): Promise<number> {
	const res = await env.DB.prepare(
		'DELETE FROM consent_records WHERE site_id = ? AND external_user_id = ?',
	)
		.bind(params.siteId, params.externalUserId)
		.run();
	return res.meta.changes ?? 0;
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
	const clause = params.externalUserId ? 'external_user_id = ?' : 'visitor_hash = ?';
	const ident = params.externalUserId ?? params.visitorHash ?? '';
	const res = await env.DB.prepare(
		`UPDATE consent_records SET revoked_at = ? WHERE site_id = ? AND tier = ? AND ${clause} AND revoked_at IS NULL`,
	)
		.bind(params.now, params.siteId, params.tier, ident)
		.run();
	return res.meta.changes ?? 0;
}
