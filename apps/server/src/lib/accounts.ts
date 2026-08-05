// Accounts & RBAC for dashboard operators (Phase 4): passwordless magic-link auth, HMAC-signed session
// tokens, and team roles. This is entirely separate from the cookieless VISITOR model — these are the
// humans who log in to view analytics. No password is ever stored; only a SHA-256 of a one-time token.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { chunked } from './constants.js';
import { constantTimeEqualHex, randomHex, sha256Hex } from './crypto.js';

/** The session cookie name, shared by the auth routes and the site-access middleware. */
export const SESSION_COOKIE = 'facet_session';

/** Team roles, from most to least privileged. */
export type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
const ROLE_RANK: Record<Role, number> = {
	viewer: 0,
	analyst: 1,
	admin: 2,
	owner: 3,
};
export function isRole(v: unknown): v is Role {
	return typeof v === 'string' && v in ROLE_RANK;
}
/** True when `have` meets or exceeds the privilege of `need`. */
export function roleAtLeast(have: Role, need: Role): boolean {
	return ROLE_RANK[have] >= ROLE_RANK[need];
}

/** The claims carried by a session token. */
export interface SessionPayload {
	/** User id. */
	sub: string;
	/** Expiry, unix ms. */
	exp: number;
	/**
	 * The user's `session_epoch` at the moment this token was signed. A session is live only while it
	 * still matches the column, which is what makes an issued token withdrawable at all.
	 *
	 * REQUIRED, and a token without it is rejected rather than read as epoch 0. A token minted before
	 * this existed cannot be checked against a revocation, and "we cannot tell whether this was
	 * revoked" has to mean revoked. The price is that every operator signs in once after the deploy.
	 */
	epoch: number;
}

const TOKEN_TTL_MS = 15 * 60 * 1000; // magic-link validity
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
function b64urlDecode(s: string): Uint8Array {
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}

/** Sign a session token (`<payload>.<hmac>`, both base64url). Pure — secret and epoch are passed in,
 * so the one caller that mints a session is the one that has just read the user. */
export async function signSession(
	sub: string,
	secret: string,
	now: number,
	epoch: number,
): Promise<string> {
	const payload: SessionPayload = { sub, exp: now + SESSION_TTL_MS, epoch };
	const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	const sig = new Uint8Array(
		await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body)),
	);
	return `${body}.${b64url(sig)}`;
}

/**
 * Verify a session token's signature + expiry, returning its claims or null.
 *
 * Pure, and NEVER sufficient on its own: it proves the token was issued by this deployment and has
 * not expired, not that the session is still live. Only `sessionUser` can answer that, because only a
 * read of `session_epoch` can. Split for the same reason `verifyConsentRecord` is split from
 * `findActiveConsent` — the cryptographic check is testable in isolation, and keeping it separate
 * makes it obvious that something else has to follow it.
 */
export async function verifySession(
	token: string,
	secret: string,
	now: number,
): Promise<SessionPayload | null> {
	const dot = token.indexOf('.');
	if (dot < 1) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	let ok: boolean;
	try {
		ok = await crypto.subtle.verify(
			'HMAC',
			await hmacKey(secret),
			b64urlDecode(sig),
			new TextEncoder().encode(body),
		);
	} catch {
		return null;
	}
	if (!ok) return null;
	try {
		const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
		if (
			typeof payload.sub !== 'string' ||
			typeof payload.exp !== 'number' ||
			// A token carrying no epoch cannot be compared against a revocation, and an unverifiable
			// revocation state must read as revoked. This is what signs everyone out once on deploy.
			typeof payload.epoch !== 'number' ||
			payload.exp < now
		) {
			return null;
		}
		return payload;
	} catch {
		return null;
	}
}

/** Create a single-use magic-link token for `email`; returns the raw token for the emailed link (only
 * its hash is stored). */
export async function createMagicToken(env: Env, email: string, now: number): Promise<string> {
	const id = randomHex(8);
	const secret = randomHex(24);
	await db(env)
		.insert(schema.authTokens)
		.values({
			id,
			tokenHash: await sha256Hex(secret),
			email: email.toLowerCase(),
			expiresAt: now + TOKEN_TTL_MS,
			createdAt: now,
		});
	return `${id}.${secret}`;
}

/** Consume a magic-link token: validate hash + expiry + single-use, mark it used, return the email. */
export async function consumeMagicToken(
	env: Env,
	token: string,
	now: number,
): Promise<string | null> {
	const dot = token.indexOf('.');
	if (dot < 1) return null;
	const id = token.slice(0, dot);
	const secret = token.slice(dot + 1);
	const row = await db(env)
		.select()
		.from(schema.authTokens)
		.where(eq(schema.authTokens.id, id))
		.get();
	if (!row || row.usedAt != null || row.expiresAt < now) return null;
	if (!constantTimeEqualHex(await sha256Hex(secret), row.tokenHash)) return null;
	await db(env)
		.update(schema.authTokens)
		.set({ usedAt: now })
		.where(eq(schema.authTokens.id, id));
	return row.email;
}

/** An authenticated operator, as every session-resolving path receives them. Carries the columns
 * `/api/auth/me` needs, so resolving a session and describing the user are one read rather than two. */
export interface SessionUser {
	id: string;
	email: string;
	name: string | null;
}

/**
 * THE ONLY WAY TO RESOLVE A SESSION. Verifies the token cryptographically, then confirms the session
 * has not been revoked by comparing its epoch against the user's current one.
 *
 * Both halves live here rather than at the call sites because a signature check that is not followed
 * by the epoch check silently restores the old behaviour — an unrevocable 30-day token — and does so
 * at whichever route forgot, which is exactly the failure nobody notices. `verifySession` alone
 * cannot authorize anything; this returns the user or null, and there is no third option.
 *
 * A missing user row is null too: an account that no longer exists has no live sessions, whatever its
 * tokens still say.
 *
 * COST. One read, and it returns the row rather than just the id, so `/api/auth/me` spends no more
 * queries than before. On the RBAC path `siteRole` is now a single joined statement instead of two,
 * so the epoch check is paid for out of a round trip that was already there.
 */
export async function sessionUser(
	env: Env,
	token: string | undefined,
	secret: string,
	now: number,
): Promise<SessionUser | null> {
	if (!token) return null;
	const payload = await verifySession(token, secret, now);
	if (!payload) return null;
	const row = await db(env)
		.select({
			id: schema.users.id,
			email: schema.users.email,
			name: schema.users.name,
			sessionEpoch: schema.users.sessionEpoch,
		})
		.from(schema.users)
		.where(eq(schema.users.id, payload.sub))
		.get();
	if (!row || row.sessionEpoch !== payload.epoch) return null;
	return { id: row.id, email: row.email, name: row.name };
}

/**
 * End every session this user currently holds, by moving the epoch past the one their tokens carry.
 * Returns false when there is no such user.
 *
 * The increment is done in SQL rather than read-then-write: two revocations racing must both land,
 * and a read-modify-write would let the second overwrite the first with the same value — which reads
 * as success while leaving the sessions the second one was called to kill still alive.
 */
export async function revokeSessions(env: Env, userId: string): Promise<boolean> {
	const rows = await db(env)
		.update(schema.users)
		.set({ sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
		.where(eq(schema.users.id, userId))
		.returning({ id: schema.users.id });
	return rows.length > 0;
}

/** Find or create a user by email. A brand-new user gets a personal team + an `owner` membership. */
export async function upsertUserByEmail(
	env: Env,
	email: string,
	now: number,
): Promise<{ id: string; email: string; sessionEpoch: number }> {
	const e = email.toLowerCase();
	const existing = await db(env)
		.select({
			id: schema.users.id,
			email: schema.users.email,
			sessionEpoch: schema.users.sessionEpoch,
		})
		.from(schema.users)
		.where(eq(schema.users.email, e))
		.get();
	if (existing) {
		await db(env)
			.update(schema.users)
			.set({ lastLogin: now })
			.where(eq(schema.users.id, existing.id));
		return existing;
	}
	const userId = randomHex(12);
	const teamId = randomHex(12);
	await db(env)
		.insert(schema.users)
		.values({ id: userId, email: e, createdAt: now, lastLogin: now });
	await db(env)
		.insert(schema.teams)
		.values({ id: teamId, name: `${e}'s team`, createdAt: now });
	await db(env)
		.insert(schema.memberships)
		.values({ teamId, userId, role: 'owner', createdAt: now });
	// A brand-new row starts at the column default, and the token minted from this must agree.
	return { id: userId, email: e, sessionEpoch: 0 };
}

/**
 * Emails for a set of operator ids, keyed by id.
 *
 * Exists for the CRM audit log, which stores `actor_user_id` because that is the stable identifier
 * and because a log that copied an email would still hold it after the account was closed. An id
 * nothing can resolve is not accountability, though, so the reader resolves it — and only the reader,
 * so the resolution follows the account rather than being frozen at write time.
 *
 * An id with no row simply does not appear: a closed account leaves entries that name it and cannot
 * be given a name back, which is the honest answer rather than an invented one.
 *
 * CHUNKED at `D1_MAX_IN_PARAMS`. One audit page can carry up to 100 distinct actors, and D1's ceiling
 * is exactly 100 bound parameters — so a full page would sit precisely on the cliff, and stay correct
 * only while two unrelated limits keep their current relationship. This takes the same margin every
 * other `IN` list in the codebase takes instead.
 */
export async function emailsByUserId(env: Env, userIds: string[]): Promise<Map<string, string>> {
	const byId = new Map<string, string>();
	const unique = [...new Set(userIds)];
	for (const batch of chunked(unique)) {
		const rows = await db(env)
			.select({ id: schema.users.id, email: schema.users.email })
			.from(schema.users)
			.where(inArray(schema.users.id, batch));
		for (const row of rows) byId.set(row.id, row.email);
	}
	return byId;
}

/** A user's team memberships (team id + role). */
export async function userMemberships(
	env: Env,
	userId: string,
): Promise<{ teamId: string; role: Role }[]> {
	const rows = await db(env)
		.select({
			teamId: schema.memberships.teamId,
			role: schema.memberships.role,
		})
		.from(schema.memberships)
		.where(eq(schema.memberships.userId, userId));
	return rows
		.filter((r) => isRole(r.role))
		.map((r) => ({ teamId: r.teamId, role: r.role as Role }));
}

/**
 * The role a user holds on the team that owns `siteId`, or null if the site is unowned or the user is
 * not a member. Used to gate dashboard (session) access to a site's analytics.
 *
 * ONE statement, joining the membership to the site that points at its team. It was two sequential
 * reads — the site, then the membership — which is two round trips to answer a question SQLite
 * answers in one, on the path every session-authenticated request takes. The inner join is also what
 * expresses "unowned site grants nobody anything": a NULL `team_id` matches no membership row, so
 * that case needs no separate branch to get right.
 */
export async function siteRole(env: Env, userId: string, siteId: string): Promise<Role | null> {
	const m = await db(env)
		.select({ role: schema.memberships.role })
		.from(schema.memberships)
		.innerJoin(schema.sites, eq(schema.sites.teamId, schema.memberships.teamId))
		.where(and(eq(schema.sites.id, siteId), eq(schema.memberships.userId, userId)))
		.get();
	return m && isRole(m.role) ? m.role : null;
}
