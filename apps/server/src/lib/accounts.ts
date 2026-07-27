// Accounts & RBAC for dashboard operators (Phase 4): passwordless magic-link auth, HMAC-signed session
// tokens, and team roles. This is entirely separate from the cookieless VISITOR model — these are the
// humans who log in to view analytics. No password is ever stored; only a SHA-256 of a one-time token.

import { eq } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { constantTimeEqualHex, randomHex, sha256Hex } from './crypto.js';

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

/** Sign a session token (`<payload>.<hmac>`, both base64url). Pure — secret is passed in. */
export async function signSession(sub: string, secret: string, now: number): Promise<string> {
	const payload: SessionPayload = { sub, exp: now + SESSION_TTL_MS };
	const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	const sig = new Uint8Array(
		await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body)),
	);
	return `${body}.${b64url(sig)}`;
}

/** Verify a session token's signature + expiry, returning its claims or null. */
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

/** Find or create a user by email. A brand-new user gets a personal team + an `owner` membership. */
export async function upsertUserByEmail(
	env: Env,
	email: string,
	now: number,
): Promise<{ id: string; email: string }> {
	const e = email.toLowerCase();
	const existing = await db(env)
		.select({ id: schema.users.id, email: schema.users.email })
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
	return { id: userId, email: e };
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
