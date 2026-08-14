// Consent + identity HTTP surface (U2). Asserts the security-relevant behaviors: consent needs a
// signing key (501), GPC refuses a grant (202, nothing written), a Tier-0 site can't grant, the
// site_id is taken from the API key (not the body), grant→revoke works, and the admin identity PATCH
// is guarded (its own admin auth, site must exist, 501 for elevation without a key).

import { env } from 'cloudflare:test';
import { generateSigningJwk } from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { issueKey } from '../src/lib/apikeys.js';

const ADMIN = 'Bearer test-admin-token';
const SITE = '88888888-8888-4888-8888-888888888888';
const app = createApp();

let signingEnv: typeof env & { FACET_SIGNING_JWK: string };

async function seedSite(e: typeof env): Promise<void> {
	await e.DB.prepare(
		'INSERT OR IGNORE INTO sites (id, name, domain, created_at) VALUES (?, ?, ?, ?)',
	)
		.bind(SITE, 'Test', 'shop.example.com', Date.now())
		.run();
}

function patchIdentity(e: typeof env, body: unknown, id = SITE) {
	return app.request(
		`/api/sites/${id}/identity`,
		{
			method: 'PATCH',
			headers: {
				Authorization: ADMIN,
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		},
		e,
	);
}

function postConsent(e: typeof env, key: string, body: unknown, gpc = false, origin = '') {
	return app.request(
		`${origin}/api/consent`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${key}`,
				'content-type': 'application/json',
				...(gpc ? { 'Sec-GPC': '1' } : {}),
			},
			body: JSON.stringify(body),
		},
		e,
	);
}

async function consentCount(e: typeof env): Promise<number> {
	const row = await e.DB.prepare('SELECT count(*) AS n FROM consent_records WHERE site_id = ?')
		.bind(SITE)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

beforeEach(async () => {
	const gen = await generateSigningJwk('EdDSA');
	signingEnv = { ...env, FACET_SIGNING_JWK: JSON.stringify(gen.privateJwk) };
	await seedSite(env);
});

const GRANT = {
	tier: 'pseudonymous',
	salt_window: 'week',
	ip: '203.0.113.9',
	user_agent: 'Mozilla/5.0 Chrome/120',
};

describe('POST /api/consent', () => {
	it('501s without a deployment signing key', async () => {
		const key = (await issueKey(env, SITE, null, Date.now())).key;
		await patchIdentity(signingEnv, {
			tier: 'pseudonymous',
			salt_window: 'week',
		});
		const res = await postConsent(env, key, GRANT); // plain env: no signing key
		expect(res.status).toBe(501);
	});

	// `iss` is the deployment DID built from the request host. A host that cannot be a did:web could
	// never satisfy the ingest-side check on that same claim, so the grant is refused at the door
	// rather than stored as a record that can only ever fail to elevate anyone.
	it('501s did_unavailable when the host cannot be a did:web', async () => {
		await patchIdentity(signingEnv, {
			tier: 'pseudonymous',
			salt_window: 'week',
		});
		const key = (await issueKey(signingEnv, SITE, null, Date.now())).key;
		const res = await postConsent(signingEnv, key, GRANT, false, 'https://192.0.2.10');
		expect(res.status).toBe(501);
		expect(await res.json()).toEqual({ error: 'did_unavailable' });
		expect(await consentCount(signingEnv)).toBe(0);
	});

	it('refuses to mint a record for a GPC visitor (202, nothing written)', async () => {
		await patchIdentity(signingEnv, {
			tier: 'pseudonymous',
			salt_window: 'week',
		});
		const key = (await issueKey(signingEnv, SITE, null, Date.now())).key;
		const res = await postConsent(signingEnv, key, GRANT, true);
		expect(res.status).toBe(202);
		expect(await consentCount(signingEnv)).toBe(0);
	});

	it('400s when the site is not elevated (Tier 0)', async () => {
		const key = (await issueKey(signingEnv, SITE, null, Date.now())).key;
		const res = await postConsent(signingEnv, key, GRANT);
		expect(res.status).toBe(400);
	});

	it('grants and revokes; the record is scoped to the key site', async () => {
		expect(
			(
				await patchIdentity(signingEnv, {
					tier: 'pseudonymous',
					salt_window: 'week',
				})
			).status,
		).toBe(200);
		const key = (await issueKey(signingEnv, SITE, null, Date.now())).key;

		const res = await postConsent(signingEnv, key, GRANT);
		expect(res.status).toBe(201);
		const { consent } = (await res.json()) as {
			consent: { statement: string };
		};
		expect(consent.statement).toBe('facet-consent/1');
		expect(await consentCount(signingEnv)).toBe(1);

		const del = await app.request(
			'/api/consent',
			{
				method: 'DELETE',
				headers: {
					Authorization: `Bearer ${key}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					tier: 'pseudonymous',
					salt_window: 'week',
					ip: GRANT.ip,
					user_agent: GRANT.user_agent,
				}),
			},
			signingEnv,
		);
		expect(del.status).toBe(200);
		expect((await del.json()) as { revoked: number }).toMatchObject({
			revoked: 1,
		});
	});

	it('rejects an unauthenticated caller', async () => {
		const res = await app.request(
			'/api/consent',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(GRANT),
			},
			signingEnv,
		);
		expect(res.status).toBe(401);
	});

	// An ip-only revoke against an identified-tier site would otherwise pass validation, then hash
	// under the pseudonymous ip|ua formula (the only one revokeConsent's route branch can compute
	// without a uid) and match zero rows — a misleading revoked:0 rather than a rejected request,
	// since an identified-tier grant is keyed by the raw uid instead.
	it('rejects an identified-tier revoke with no user_id, instead of a silent revoked:0', async () => {
		const key = (await issueKey(signingEnv, SITE, null, Date.now())).key;
		const del = await app.request(
			'/api/consent',
			{
				method: 'DELETE',
				headers: {
					Authorization: `Bearer ${key}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					tier: 'identified',
					salt_window: 'week',
					ip: GRANT.ip,
					user_agent: GRANT.user_agent,
				}),
			},
			signingEnv,
		);
		expect(del.status).toBe(400);
		expect(await del.json()).toMatchObject({
			error: 'validation_failed',
			issues: [{ message: 'user_id_required_for_identified' }],
		});
	});
});

describe('PATCH /api/sites/:id/identity', () => {
	it('sets a tier with admin auth + signing key', async () => {
		const res = await patchIdentity(signingEnv, {
			tier: 'pseudonymous',
			salt_window: 'week',
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { identity: unknown }).toMatchObject({
			identity: { tier: 'pseudonymous', salt_window: 'week' },
		});
	});

	it('501s when elevating above anonymous with no signing key', async () => {
		const res = await patchIdentity(env, {
			tier: 'identified',
			salt_window: 'month',
		});
		expect(res.status).toBe(501);
	});

	it('404s for a site that does not exist', async () => {
		const res = await patchIdentity(
			signingEnv,
			{ tier: 'pseudonymous', salt_window: 'week' },
			'99999999-9999-4999-8999-999999999999',
		);
		expect(res.status).toBe(404);
	});

	it('401s without the admin token', async () => {
		const res = await app.request(
			`/api/sites/${SITE}/identity`,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tier: 'anonymous', salt_window: 'day' }),
			},
			signingEnv,
		);
		expect(res.status).toBe(401);
	});
});
