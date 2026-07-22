// Consent security kernel (U2). The two CRITICAL properties from the design review, tested directly:
//   1. A consent statement forged with an ATTACKER's own key (self-embedded JWK) is rejected, because
//      verification is pinned to the deployment key's kid — not the key embedded in the statement.
//   2. A genuine statement is rejected when replayed into a different site/tier/window/hash context,
//      because the SIGNED payload — not the DB columns — is bound to the enforcement context.
// Also: a genuine statement in its correct context verifies; expiry and revocation drop elevation.

import { env } from 'cloudflare:test';
import { generateSigningJwk, loadSigningKey } from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	type ConsentClaims,
	type ConsentContext,
	findActiveConsent,
	revokeConsent,
	signConsent,
	storeConsentRecord,
	verifyConsentRecord,
} from '../src/lib/consent.js';
import { deploymentDid } from '../src/lib/signing.js';

const SITE = '66666666-6666-4666-8666-666666666666';
const url = new URL('https://facet.example/api/consent');
const ISS = deploymentDid(url);
const VH = 'a'.repeat(64);

const claims = (over: Partial<ConsentClaims> = {}): ConsentClaims => ({
	iss: ISS,
	site_id: SITE,
	visitor_hash: VH,
	tier: 'pseudonymous',
	salt_window: 'week',
	window_key: '2026-W29',
	external_user_id_present: false,
	gpc_at_grant: 0,
	granted_at: new Date(0).toISOString(),
	...over,
});

const ctx = (over: Partial<ConsentContext> = {}, kid: string): ConsentContext => ({
	siteId: SITE,
	visitorHash: VH,
	tier: 'pseudonymous',
	windowKey: '2026-W29',
	iss: ISS,
	kid,
	...over,
});

describe('verifyConsentRecord (security kernel)', () => {
	it('accepts a genuine statement in its exact context', async () => {
		const gen = await generateSigningJwk('EdDSA');
		const key = await loadSigningKey(JSON.stringify(gen.privateJwk));
		const stmt = await signConsent(key, claims(), 0);
		expect(await verifyConsentRecord(stmt, ctx({}, key.kid))).toBe(true);
	});

	it('rejects a forgery signed with an attacker key (deployment-key pinning)', async () => {
		const deployment = await loadSigningKey(
			JSON.stringify((await generateSigningJwk('EdDSA')).privateJwk),
		);
		const attacker = await loadSigningKey(
			JSON.stringify((await generateSigningJwk('EdDSA')).privateJwk),
		);
		// The attacker mints a perfectly self-consistent statement with their OWN embedded key.
		const forged = await signConsent(attacker, claims({ tier: 'identified' }), 0);
		// verifyStatement alone would pass; pinning to the deployment kid rejects it.
		expect(await verifyConsentRecord(forged, ctx({ tier: 'identified' }, deployment.kid))).toBe(
			false,
		);
	});

	it('rejects replay into a different site / tier / window / hash', async () => {
		const key = await loadSigningKey(
			JSON.stringify((await generateSigningJwk('EdDSA')).privateJwk),
		);
		const stmt = await signConsent(key, claims(), 0);
		expect(await verifyConsentRecord(stmt, ctx({ siteId: 'other-site' }, key.kid))).toBe(false);
		expect(await verifyConsentRecord(stmt, ctx({ tier: 'identified' }, key.kid))).toBe(false);
		expect(await verifyConsentRecord(stmt, ctx({ windowKey: '2026-W30' }, key.kid))).toBe(
			false,
		);
		expect(await verifyConsentRecord(stmt, ctx({ visitorHash: 'b'.repeat(64) }, key.kid))).toBe(
			false,
		);
	});

	it('rejects a tampered payload', async () => {
		const key = await loadSigningKey(
			JSON.stringify((await generateSigningJwk('EdDSA')).privateJwk),
		);
		const stmt = await signConsent(key, claims(), 0);
		// Mutate a signed claim after signing: the signature no longer covers it.
		stmt.payload.tier = 'identified';
		expect(await verifyConsentRecord(stmt, ctx({ tier: 'identified' }, key.kid))).toBe(false);
	});
});

describe('findActiveConsent', () => {
	let signingEnv: typeof env & { FACET_SIGNING_JWK: string };
	let kid: string;

	beforeEach(async () => {
		const gen = await generateSigningJwk('EdDSA');
		signingEnv = {
			...env,
			FACET_SIGNING_JWK: JSON.stringify(gen.privateJwk),
		};
		kid = (await loadSigningKey(JSON.stringify(gen.privateJwk))).kid;
	});

	async function grant(over: Partial<ConsentClaims> = {}, expiresAt: number | null = null) {
		const key = await loadSigningKey(signingEnv.FACET_SIGNING_JWK);
		const stmt = await signConsent(key, claims(over), 0);
		await storeConsentRecord(signingEnv, {
			id: crypto.randomUUID(),
			siteId: SITE,
			visitorHash: over.visitor_hash ?? VH,
			tier: over.tier ?? 'pseudonymous',
			externalUserId: null,
			saltWindow: 'week',
			windowKey: over.window_key ?? '2026-W29',
			gpcAtGrant: 0,
			grantedAt: 0,
			expiresAt,
			statement: stmt,
		});
	}

	it('returns null with no deployment key (never elevates)', async () => {
		await grant();
		const found = await findActiveConsent(env, url, {
			siteId: SITE,
			visitorHash: VH,
			tier: 'pseudonymous',
			windowKey: '2026-W29',
			now: 1000,
		});
		expect(found).toBeNull();
	});

	it('returns the record for an active, correctly-bound grant', async () => {
		await grant();
		const found = await findActiveConsent(signingEnv, url, {
			siteId: SITE,
			visitorHash: VH,
			tier: 'pseudonymous',
			windowKey: '2026-W29',
			now: 1000,
		});
		expect(found?.payload.window_key).toBe('2026-W29');
		expect(kid).toBeTruthy();
	});

	it('does not elevate after expiry or revocation', async () => {
		await grant({}, 500);
		const expired = await findActiveConsent(signingEnv, url, {
			siteId: SITE,
			visitorHash: VH,
			tier: 'pseudonymous',
			windowKey: '2026-W29',
			now: 1000,
		});
		expect(expired).toBeNull();

		await grant(); // fresh, non-expiring
		const revoked = await revokeConsent(signingEnv, {
			siteId: SITE,
			tier: 'pseudonymous',
			visitorHash: VH,
			now: 1000,
		});
		expect(revoked).toBeGreaterThan(0);
		const after = await findActiveConsent(signingEnv, url, {
			siteId: SITE,
			visitorHash: VH,
			tier: 'pseudonymous',
			windowKey: '2026-W29',
			now: 2000,
		});
		expect(after).toBeNull();
	});
});
