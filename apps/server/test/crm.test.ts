// CRM foundation, contacts and companies. The assertions that matter here are the boundary ones, not
// the CRUD: that the extension does not exist without its binding, that an API key can never reach
// contact PII, that the analytics link is authorized by a SIGNED consent statement rather than by a
// column, that retention severs that link on its own, and that deleting a contact really deletes.
//
// For companies the boundary is the same one applied per contact: a rollup must be the sum of the
// individually-consented, so the tests that matter are the ones where a contact at the company has
// events sitting right there and is still excluded — revoked consent, and a forged statement.

import { env } from 'cloudflare:test';
import { CRM_MAX_OFFSET } from '@facet/shared';
import { generateSigningJwk } from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
	COMPANY_ROLLUP_MAX_CONTACTS,
	CONTACT_EXPORT_MAX_EVENTS,
} from '../src/db/contact-analytics.js';
import { companyContactLinkage, foreignKeyViolation } from '../src/db/crm.js';
import {
	SESSION_COOKIE,
	signSession,
	upsertUserByEmail,
	userMemberships,
} from '../src/lib/accounts.js';
import { issueKey } from '../src/lib/apikeys.js';
import { enforceRetention } from '../src/lib/retention.js';

const SITE = '77777777-7777-4777-8777-777777777777';
const ADMIN = 'Bearer test-admin-token';
const DAY = 86_400_000;
const app = createApp();

type TestEnv = typeof env;

/** An env with the CRM binding removed — what a deployment that never created the database is. */
function unbound(e: TestEnv): TestEnv {
	const { CRM_DB: Omitted, ...rest } = e;
	return rest as unknown as TestEnv;
}

/** An env with a deployment signing key, which consent records require to be verifiable. */
async function withSigningKey(e: TestEnv): Promise<TestEnv> {
	const gen = await generateSigningJwk('EdDSA');
	return { ...e, FACET_SIGNING_JWK: JSON.stringify(gen.privateJwk) };
}

async function seedSite(e: TestEnv): Promise<void> {
	await e.DB.prepare(
		'INSERT OR IGNORE INTO sites (id, name, domain, created_at) VALUES (?, ?, ?, ?)',
	)
		.bind(SITE, 'Test', 'shop.example.com', Date.now())
		.run();
}

/** Create an operator with `role` on the team owning SITE, and return their session cookie. */
async function operator(e: TestEnv, email: string, role: string): Promise<string> {
	const now = Date.now();
	const user = await upsertUserByEmail(e, email, now);
	const teamId = (await userMemberships(e, user.id))[0]?.teamId as string;
	await e.DB.prepare('UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?')
		.bind(role, teamId, user.id)
		.run();
	await e.DB.prepare('UPDATE sites SET team_id = ? WHERE id = ?').bind(teamId, SITE).run();
	const secret = e.SESSION_SECRET as string;
	return `${SESSION_COOKIE}=${await signSession(user.id, secret, now, user.sessionEpoch)}`;
}

function crm(e: TestEnv, path: string, init: RequestInit = {}, cookie?: string) {
	const sep = path.includes('?') ? '&' : '?';
	return app.request(
		`/api/crm${path}${sep}site_id=${SITE}`,
		{
			...init,
			headers: {
				'content-type': 'application/json',
				...(cookie ? { cookie } : {}),
				...(init.headers ?? {}),
			},
		},
		e,
	);
}

async function createContact(
	e: TestEnv,
	cookie: string,
	body: Record<string, unknown>,
): Promise<{ id: string; external_user_id: string | null }> {
	const res = await crm(e, '/contacts', { method: 'POST', body: JSON.stringify(body) }, cookie);
	expect(res.status).toBe(201);
	const json = (await res.json()) as { contact: { id: string; external_user_id: string | null } };
	return json.contact;
}

async function createCompany(
	e: TestEnv,
	cookie: string,
	body: Record<string, unknown>,
): Promise<{ id: string; name: string; domain: string | null }> {
	const res = await crm(e, '/companies', { method: 'POST', body: JSON.stringify(body) }, cookie);
	expect(res.status).toBe(201);
	const json = (await res.json()) as {
		company: { id: string; name: string; domain: string | null };
	};
	return json.company;
}

async function createDeal(
	e: TestEnv,
	cookie: string,
	body: Record<string, unknown>,
): Promise<{ id: string; stage: string; value: number | null; currency: string | null }> {
	const res = await crm(e, '/deals', { method: 'POST', body: JSON.stringify(body) }, cookie);
	expect(res.status).toBe(201);
	const json = (await res.json()) as {
		deal: { id: string; stage: string; value: number | null; currency: string | null };
	};
	return json.deal;
}

beforeEach(async () => {
	await seedSite(env);
});

describe('the binding is the gate', () => {
	it('501s every CRM route when CRM_DB is unbound, before authenticating', async () => {
		const e = unbound(env);
		for (const path of [
			'/contacts',
			'/contacts/anything',
			'/contacts/anything/export',
			'/companies',
			'/companies/anything',
			'/companies/anything/contacts',
			'/companies/anything/analytics',
			'/deals',
			'/deals/anything',
			'/pipeline',
		]) {
			const res = await crm(e, path);
			expect(res.status).toBe(501);
			expect(await res.json()).toMatchObject({ error: 'crm_unavailable' });
		}
	});

	it('answers 501 rather than 404 for an unknown CRM path, so the route table does not leak', async () => {
		const res = await crm(unbound(env), '/contacts/x/not-a-real-endpoint');
		expect(res.status).toBe(501);
	});

	it('puts the contacts table in a genuinely separate database', async () => {
		// The whole isolation claim rests on this: "excluded" has to mean the table does not exist,
		// not that a flag hides it. If these two bindings ever resolved to one database, the CRM
		// would be one migration away from being joinable to events without passing consent.
		const inAnalytics = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contacts'",
		).first();
		expect(inAnalytics).toBeNull();
		const inCrm = await env.CRM_DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contacts'",
		).first();
		expect(inCrm).not.toBeNull();
		// And the converse: the analytics tables are not in the CRM database.
		const eventsInCrm = await env.CRM_DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
		).first();
		expect(eventsInCrm).toBeNull();
	});
});

describe('contact PII is not reachable with an API key', () => {
	it('rejects a valid site API key on every contacts route', async () => {
		// The load-bearing test. A clk_ key is deliberately handed to LLM agents and can be embedded
		// in a public demo dashboard; it authorizes aggregate stats and must never authorize a name
		// or an email. If this ever passes a 200, the key's blast radius has silently become PII.
		const { key } = await issueKey(env, SITE, 'agent', Date.now());
		const auth = { Authorization: `Bearer ${key}` };
		for (const [path, init] of [
			['/contacts', {}],
			['/contacts', { method: 'POST', body: '{"name":"x"}' }],
			['/contacts/abc', {}],
			['/contacts/abc/export', {}],
			['/contacts/abc/analytics', {}],
			['/companies', {}],
			['/companies', { method: 'POST', body: '{"name":"x"}' }],
			['/companies/abc', {}],
			['/companies/abc/contacts', {}],
			['/companies/abc/analytics', {}],
			['/deals', {}],
			['/deals', { method: 'POST', body: '{"name":"x"}' }],
			['/deals/abc', {}],
			['/pipeline', {}],
		] as const) {
			const res = await crm(env, path, { ...init, headers: auth });
			expect(res.status).toBe(401);
		}
		// The same key still reads aggregate stats, so this is a CRM-specific boundary rather than
		// the key having been broken.
		const now = Date.now();
		const stats = await app.request(
			`/api/stats?site_id=${SITE}&start=${now - DAY}&end=${now}`,
			{ headers: auth },
			env,
		);
		expect(stats.status).toBe(200);
	});

	it('rejects the admin token too, so the surface is uniformly session-only', async () => {
		const res = await crm(env, '/contacts', { headers: { Authorization: ADMIN } });
		expect(res.status).toBe(401);
	});

	it('503s when the deployment has no SESSION_SECRET to authenticate an operator with', async () => {
		const { SESSION_SECRET: Omitted, ...rest } = env;
		const res = await crm(rest as unknown as TestEnv, '/contacts');
		expect(res.status).toBe(503);
	});
});

describe('roles', () => {
	it('lets an analyst read and write, but not delete or export', async () => {
		const cookie = await operator(env, 'analyst@example.com', 'analyst');
		const contact = await createContact(env, cookie, { name: 'Ada', email: 'ada@example.com' });
		expect((await crm(env, '/contacts', {}, cookie)).status).toBe(200);
		expect(
			(
				await crm(
					env,
					`/contacts/${contact.id}`,
					{ method: 'PATCH', body: JSON.stringify({ title: 'CTO' }) },
					cookie,
				)
			).status,
		).toBe(200);
		// Erasure and bulk single-subject disclosure are admin-only.
		expect((await crm(env, `/contacts/${contact.id}/export`, {}, cookie)).status).toBe(403);
		expect(
			(await crm(env, `/contacts/${contact.id}`, { method: 'DELETE' }, cookie)).status,
		).toBe(403);
	});

	it('lets an analyst manage companies, but not delete one', async () => {
		const cookie = await operator(env, 'analyst@example.com', 'analyst');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		expect((await crm(env, '/companies', {}, cookie)).status).toBe(200);
		expect((await crm(env, `/companies/${company.id}/contacts`, {}, cookie)).status).toBe(200);
		expect(
			(await crm(env, `/companies/${company.id}`, { method: 'DELETE' }, cookie)).status,
		).toBe(403);
	});

	it('lets an analyst manage deals, but not delete one', async () => {
		const cookie = await operator(env, 'analyst@example.com', 'analyst');
		const deal = await createDeal(env, cookie, { name: 'Acme renewal' });
		expect((await crm(env, '/deals', {}, cookie)).status).toBe(200);
		expect((await crm(env, '/pipeline', {}, cookie)).status).toBe(200);
		expect(
			(
				await crm(
					env,
					`/deals/${deal.id}`,
					{ method: 'PATCH', body: JSON.stringify({ stage: 'qualified' }) },
					cookie,
				)
			).status,
		).toBe(200);
		expect((await crm(env, `/deals/${deal.id}`, { method: 'DELETE' }, cookie)).status).toBe(
			403,
		);
	});

	it('gives a viewer no CRM access at all', async () => {
		const cookie = await operator(env, 'viewer@example.com', 'viewer');
		expect((await crm(env, '/contacts', {}, cookie)).status).toBe(403);
		expect((await crm(env, '/companies', {}, cookie)).status).toBe(403);
		expect((await crm(env, '/deals', {}, cookie)).status).toBe(403);
	});

	it('blocks an operator with no role on the site', async () => {
		await operator(env, 'owner@example.com', 'owner');
		const now = Date.now();
		const outsider = await upsertUserByEmail(env, 'outsider@example.com', now);
		const cookie = `${SESSION_COOKIE}=${await signSession(outsider.id, env.SESSION_SECRET as string, now, outsider.sessionEpoch)}`;
		expect((await crm(env, '/contacts', {}, cookie)).status).toBe(403);
	});
});

describe('contacts', () => {
	it('scopes reads to the authorized site', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const contact = await createContact(env, cookie, { name: 'Ada', email: 'ada@example.com' });
		// The row exists, but under a different site it is indistinguishable from a missing one.
		await env.CRM_DB.prepare('UPDATE contacts SET site_id = ? WHERE id = ?')
			.bind('99999999-9999-4999-8999-999999999999', contact.id)
			.run();
		expect((await crm(env, `/contacts/${contact.id}`, {}, cookie)).status).toBe(404);
	});

	it('normalises email case so one person cannot exist twice', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		await createContact(env, cookie, { name: 'Ada', email: 'Ada@Example.COM' });
		const dupe = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ email: 'ada@example.com' }) },
			cookie,
		);
		expect(dupe.status).toBe(409);
	});

	it('refuses a row with no identifier at all', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const res = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ notes: 'met at a conference' }) },
			cookie,
		);
		expect(res.status).toBe(400);
	});

	it('rejects a malformed email while still accepting a blank one', async () => {
		// The distinction the schema turns on: `''` means "not supplied" (a form submits every
		// field), but `not-an-email` is a value the unique index would happily dedupe on and no
		// erasure request could ever be matched against.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const bad = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada', email: 'not-an-email' }) },
			cookie,
		);
		expect(bad.status).toBe(400);
		const blank = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada', email: '   ' }) },
			cookie,
		);
		expect(blank.status).toBe(201);
	});

	it('treats a blank optional field as unset rather than as an empty string', async () => {
		// Two contacts each submitting an empty email must not collide on the unique index.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		await createContact(env, cookie, { name: 'One', email: '' });
		const second = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Two', email: '' }) },
			cookie,
		);
		expect(second.status).toBe(201);
	});

	it('leaves omitted fields alone on PATCH', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const contact = await createContact(env, cookie, { name: 'Ada', notes: 'keep me' });
		await crm(
			env,
			`/contacts/${contact.id}`,
			{ method: 'PATCH', body: JSON.stringify({ title: 'CTO' }) },
			cookie,
		);
		const res = await crm(env, `/contacts/${contact.id}`, {}, cookie);
		const { contact: updated } = (await res.json()) as {
			contact: { notes: string | null; title: string | null };
		};
		expect(updated.notes).toBe('keep me');
		expect(updated.title).toBe('CTO');
	});

	it('rejects an owner_user_id that resolves to nobody', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const res = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada', owner_user_id: 'nope' }) },
			cookie,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'unknown_owner' });
	});

	it('treats a % in the search box as a literal, matching neither everything nor nothing', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		await createContact(env, cookie, { name: 'Ada', email: 'ada@example.com' });
		await createContact(env, cookie, { name: '100% Widgets', email: 'w@example.com' });

		// Not a wildcard: the contact without a `%` in its name is not returned.
		const res = await crm(env, '/contacts?q=%25', {}, cookie);
		const { contacts, total } = (await res.json()) as {
			contacts: { name: string }[];
			total: number;
		};
		// And not inert either. Asserting only `total !== 2` would also pass if the escaping matched
		// nothing at all, which is what happens without SQLite's ESCAPE clause — so the literal has
		// to be shown actually finding its row.
		expect(total).toBe(1);
		expect(contacts[0]?.name).toBe('100% Widgets');

		// The other metacharacter, same rule: `_` is a single-character wildcard in LIKE.
		const underscore = await crm(env, '/contacts?q=_', {}, cookie);
		expect(((await underscore.json()) as { total: number }).total).toBe(0);
	});
});

describe('the analytics link is gated on signed consent', () => {
	const UID = 'customer-42';

	/** Grant identified-tier consent for UID and return the visitor hash it was signed over. */
	async function grantConsent(e: TestEnv): Promise<string> {
		await e.DB.prepare(
			'INSERT OR REPLACE INTO site_config (site_id, tier, salt_window, updated_at) VALUES (?, ?, ?, ?)',
		)
			.bind(SITE, 'identified', 'day', Date.now())
			.run();
		const { key } = await issueKey(e, SITE, 'server', Date.now());
		const res = await app.request(
			'/api/consent',
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					tier: 'identified',
					salt_window: 'day',
					user_id: UID,
					ip: '203.0.113.9',
					user_agent: 'test-agent',
				}),
			},
			e,
		);
		expect(res.status).toBe(201);
		const row = await e.DB.prepare(
			'SELECT visitor_hash FROM consent_records WHERE site_id = ? AND external_user_id = ?',
		)
			.bind(SITE, UID)
			.first<{ visitor_hash: string }>();
		return row?.visitor_hash as string;
	}

	/** One pageview and one custom event. A pageview is `name IS NULL` in this schema — writing
	 * `name = 'pageview'` produces a CUSTOM event, so a fixture that did would make a summary
	 * counting the wrong predicate look correct. */
	async function seedEventsFor(e: TestEnv, hash: string, createdAt: number): Promise<void> {
		const insert = e.DB.prepare(
			`INSERT INTO events (id, site_id, name, hostname, path, referrer, visitor_hash, created_at)
			 VALUES (?, ?, ?, 'shop.example.com', '/pricing', '', ?, ?)`,
		);
		await e.DB.batch([
			insert.bind(crypto.randomUUID(), SITE, null, hash, createdAt),
			insert.bind(crypto.randomUUID(), SITE, 'signup', hash, createdAt + 1),
		]);
	}

	it('reports no linkage for a contact with no external_user_id', async () => {
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const contact = await createContact(e, cookie, { name: 'Ada', email: 'ada@example.com' });
		const res = await crm(e, `/contacts/${contact.id}/analytics`, {}, cookie);
		expect(await res.json()).toMatchObject({ linked: false, reason: 'no_external_user_id' });
	});

	it('reports no linkage for an external_user_id with no consent record', async () => {
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const contact = await createContact(e, cookie, { name: 'Ada', external_user_id: UID });
		const res = await crm(e, `/contacts/${contact.id}/analytics`, {}, cookie);
		expect(await res.json()).toMatchObject({ linked: false, reason: 'no_active_consent' });
	});

	it('links a contact to their events once consent is granted', async () => {
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const hash = await grantConsent(e);
		await seedEventsFor(e, hash, Date.now() - 1000);
		const contact = await createContact(e, cookie, { name: 'Ada', external_user_id: UID });
		const res = await crm(e, `/contacts/${contact.id}/analytics`, {}, cookie);
		const body = (await res.json()) as {
			linked: boolean;
			activity: {
				pageviews: number;
				events: number;
				total: number;
				top_paths: { path: string }[];
			};
		};
		expect(body.linked).toBe(true);
		// The pageview/custom-event split must match what /api/stats reports for the same rows, or
		// one person's numbers disagree with everyone's.
		expect(body.activity.pageviews).toBe(1);
		expect(body.activity.events).toBe(1);
		expect(body.activity.total).toBe(2);
		expect(body.activity.top_paths[0]?.path).toBe('/pricing');
	});

	it('severs the link when consent is revoked', async () => {
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const hash = await grantConsent(e);
		await seedEventsFor(e, hash, Date.now() - 1000);
		const contact = await createContact(e, cookie, { name: 'Ada', external_user_id: UID });
		await e.DB.prepare('UPDATE consent_records SET revoked_at = ? WHERE external_user_id = ?')
			.bind(Date.now(), UID)
			.run();
		const res = await crm(e, `/contacts/${contact.id}/analytics`, {}, cookie);
		expect(await res.json()).toMatchObject({ linked: false, reason: 'no_active_consent' });
	});

	it('ignores a hand-written consent row whose statement is not signed by the deployment', async () => {
		// The forgery case. `external_user_id` is only an index; the visitor hash comes out of the
		// SIGNED claims. Writing a row that points at someone else's hash must link nothing — if it
		// did, anyone with write access to consent_records could attach a contact to any visitor.
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const victimHash = 'a'.repeat(64);
		await seedEventsFor(e, victimHash, Date.now() - 1000);
		await e.DB.prepare(
			`INSERT INTO consent_records
			 (id, site_id, visitor_hash, tier, external_user_id, salt_window, window_key, gpc_at_grant, granted_at, expires_at, revoked_at, statement)
			 VALUES (?, ?, ?, 'identified', ?, 'day', '2026-01-01', 0, ?, NULL, NULL, ?)`,
		)
			.bind(
				crypto.randomUUID(),
				SITE,
				victimHash,
				UID,
				Date.now(),
				// A COMPLETE, plausible payload: right site, right tier, uid-present, pointing at the
				// victim's hash. Every claim-to-context equality passes, so the only thing that can
				// reject this row is the signature check and the deployment-key pinning. Written this
				// way deliberately — a payload missing fields would be rejected by the field checks
				// and the test would pass even with the crypto disabled.
				JSON.stringify({
					payload: {
						iss: 'did:web:example.com',
						site_id: SITE,
						visitor_hash: victimHash,
						tier: 'identified',
						salt_window: 'day',
						window_key: '2026-01-01',
						external_user_id_present: true,
						gpc_at_grant: 0,
						granted_at: new Date().toISOString(),
					},
					proof: { kid: 'forged', alg: 'EdDSA', signature: 'not-a-signature' },
				}),
			)
			.run();
		const contact = await createContact(e, cookie, { name: 'Mallory', external_user_id: UID });
		const res = await crm(e, `/contacts/${contact.id}/analytics`, {}, cookie);
		expect(await res.json()).toMatchObject({ linked: false, reason: 'no_active_consent' });
	});

	it('links nothing when the deployment has no signing key, since nothing is verifiable', async () => {
		const signed = await withSigningKey(env);
		const cookie = await operator(signed, 'admin@example.com', 'admin');
		const hash = await grantConsent(signed);
		await seedEventsFor(signed, hash, Date.now() - 1000);
		const contact = await createContact(signed, cookie, { name: 'Ada', external_user_id: UID });
		// Same data, but the key is gone: the stored statement can no longer be pinned to anything.
		const res = await crm(env, `/contacts/${contact.id}/analytics`, {}, cookie);
		expect(await res.json()).toMatchObject({ linked: false, reason: 'no_active_consent' });
	});

	it('lets retention sever the link on its own, without touching the contact', async () => {
		// The retention contract for the CRM: a contact is a business record and is NOT on the raw
		// purge schedule, but the LINK is. Nothing here caches a visitor hash, so once the consent
		// record ages out the join simply stops resolving — no CRM-side cleanup exists to forget.
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const hash = await grantConsent(e);
		await seedEventsFor(e, hash, Date.now() - 1000);
		const contact = await createContact(e, cookie, { name: 'Ada', external_user_id: UID });

		const before = await crm(e, `/contacts/${contact.id}/analytics`, {}, cookie);
		expect(await before.json()).toMatchObject({ linked: true });

		// Age the consent record past the window and run the ordinary purge job.
		await e.DB.prepare('UPDATE consent_records SET granted_at = ? WHERE external_user_id = ?')
			.bind(Date.now() - 200 * DAY, UID)
			.run();
		await enforceRetention(e, Date.now());

		const after = await crm(e, `/contacts/${contact.id}/analytics`, {}, cookie);
		expect(await after.json()).toMatchObject({ linked: false, reason: 'no_active_consent' });
		// The contact itself is untouched — retention purges analytics, not business records.
		const still = await crm(e, `/contacts/${contact.id}`, {}, cookie);
		expect(still.status).toBe(200);
	});
});

describe('erasure and export', () => {
	const UID = 'customer-99';

	it('really deletes the contact and erases the consent rows holding their raw id', async () => {
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		await e.DB.prepare(
			'INSERT OR REPLACE INTO site_config (site_id, tier, salt_window, updated_at) VALUES (?, ?, ?, ?)',
		)
			.bind(SITE, 'identified', 'day', Date.now())
			.run();
		const { key } = await issueKey(e, SITE, 'server', Date.now());
		await app.request(
			'/api/consent',
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					tier: 'identified',
					salt_window: 'day',
					user_id: UID,
					ip: '203.0.113.9',
				}),
			},
			e,
		);
		const contact = await createContact(e, cookie, {
			name: 'Ada',
			email: 'ada@example.com',
			external_user_id: UID,
		});

		const res = await crm(e, `/contacts/${contact.id}`, { method: 'DELETE' }, cookie);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ deleted: true, consent_records_erased: 1 });

		// Gone, not tombstoned: a row still carrying the email would still be that person's data.
		const row = await e.CRM_DB.prepare('SELECT count(*) AS n FROM contacts WHERE id = ?')
			.bind(contact.id)
			.first<{ n: number }>();
		expect(row?.n).toBe(0);
		// And the consent rows are DELETEd, not just revoked — `revoked_at` would leave the raw
		// external_user_id at rest, which is exactly what the erasure was about.
		const consent = await e.DB.prepare(
			'SELECT count(*) AS n FROM consent_records WHERE external_user_id = ?',
		)
			.bind(UID)
			.first<{ n: number }>();
		expect(consent?.n).toBe(0);
	});

	it('404s a second delete rather than reporting success twice', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const contact = await createContact(env, cookie, { name: 'Ada' });
		expect(
			(await crm(env, `/contacts/${contact.id}`, { method: 'DELETE' }, cookie)).status,
		).toBe(200);
		expect(
			(await crm(env, `/contacts/${contact.id}`, { method: 'DELETE' }, cookie)).status,
		).toBe(404);
	});

	it('says so when the export hits its event cap, for pageview-only traffic', async () => {
		// The cap must be measured against ALL rows, not the custom-event count. A contact whose
		// traffic is entirely pageviews (the common case) has zero custom events, so comparing
		// against that number reports `truncated: false` while a thousand rows are dropped — a
		// subject-access request answered incorrectly, which is the one thing the flag exists to
		// prevent. Seeded as pageviews (`name IS NULL`) precisely because that is the blind spot.
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const hash = 'b'.repeat(64);
		const insert = e.DB.prepare(
			`INSERT INTO events (id, site_id, name, hostname, path, referrer, visitor_hash, created_at)
			 VALUES (?, ?, NULL, 'shop.example.com', '/', '', ?, ?)`,
		);
		const over = CONTACT_EXPORT_MAX_EVENTS + 1;
		for (let i = 0; i < over; i += 500) {
			await e.DB.batch(
				Array.from({ length: Math.min(500, over - i) }, (_, j) =>
					insert.bind(crypto.randomUUID(), SITE, hash, Date.now() - (i + j)),
				),
			);
		}
		// Link the contact by minting real consent, then pointing it at the seeded hash: the export
		// path only ever sees hashes that came out of a verified statement.
		await e.DB.prepare(
			'INSERT OR REPLACE INTO site_config (site_id, tier, salt_window, updated_at) VALUES (?, ?, ?, ?)',
		)
			.bind(SITE, 'identified', 'day', Date.now())
			.run();
		const { key } = await issueKey(e, SITE, 'server', Date.now());
		await app.request(
			'/api/consent',
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					tier: 'identified',
					salt_window: 'day',
					user_id: UID,
					ip: '203.0.113.9',
				}),
			},
			e,
		);
		const granted = await e.DB.prepare(
			'SELECT visitor_hash FROM consent_records WHERE external_user_id = ?',
		)
			.bind(UID)
			.first<{ visitor_hash: string }>();
		await e.DB.prepare('UPDATE events SET visitor_hash = ? WHERE visitor_hash = ?')
			.bind(granted?.visitor_hash as string, hash)
			.run();

		const contact = await createContact(e, cookie, { name: 'Ada', external_user_id: UID });
		const res = await crm(e, `/contacts/${contact.id}/export`, {}, cookie);
		const body = (await res.json()) as {
			analytics: {
				activity: { pageviews: number; events: number; total: number };
				events: unknown[];
				events_truncated: boolean;
			};
		};
		expect(body.analytics.activity.total).toBe(over);
		expect(body.analytics.activity.pageviews).toBe(over);
		// Zero custom events is exactly the case the wrong comparison got wrong.
		expect(body.analytics.activity.events).toBe(0);
		expect(body.analytics.events.length).toBe(CONTACT_EXPORT_MAX_EVENTS);
		expect(body.analytics.events_truncated).toBe(true);
	});

	it('exports the contact, their consent evidence, and their events', async () => {
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const contact = await createContact(e, cookie, { name: 'Ada', email: 'ada@example.com' });
		const res = await crm(e, `/contacts/${contact.id}/export`, {}, cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			contact: { email: string };
			consent: unknown[];
			analytics: { linked: boolean; events_truncated: boolean; events_limit: number };
		};
		expect(body.contact.email).toBe('ada@example.com');
		expect(body.consent).toEqual([]);
		expect(body.analytics.linked).toBe(false);
		// The cap is stated in the response rather than applied silently.
		expect(body.analytics.events_truncated).toBe(false);
		expect(body.analytics.events_limit).toBeGreaterThan(0);
	});
});

describe('companies', () => {
	it('refuses a company with no name, since nothing could refer to it', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const res = await crm(
			env,
			'/companies',
			{ method: 'POST', body: JSON.stringify({ domain: 'acme.com' }) },
			cookie,
		);
		expect(res.status).toBe(400);
	});

	it('dedupes by name and by domain, and says which one collided', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		await createCompany(env, cookie, { name: 'Acme', domain: 'acme.com' });
		const sameName = await crm(
			env,
			'/companies',
			{ method: 'POST', body: JSON.stringify({ name: 'Acme' }) },
			cookie,
		);
		expect(sameName.status).toBe(409);
		expect(await sameName.json()).toMatchObject({ error: 'company_exists' });
		const sameDomain = await crm(
			env,
			'/companies',
			{ method: 'POST', body: JSON.stringify({ name: 'Acme Two', domain: 'acme.com' }) },
			cookie,
		);
		expect(sameDomain.status).toBe(409);
		expect(((await sameDomain.json()) as { message: string }).message).toMatch(/domain/);
	});

	it('normalises a domain so a pasted URL is the same company as a bare host', async () => {
		// The dedupe key is only a key if `https://Acme.com/about` and `acme.com` land on one value.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, {
			name: 'Acme',
			domain: 'https://Acme.com/about?x=1',
		});
		expect(company.domain).toBe('acme.com');
		const dupe = await crm(
			env,
			'/companies',
			{ method: 'POST', body: JSON.stringify({ name: 'Acme Two', domain: 'ACME.com.' }) },
			cookie,
		);
		expect(dupe.status).toBe(409);
	});

	it('rejects a domain that is not a hostname at all', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		for (const domain of ['not a domain', 'localhost', 'acme..com', '-acme.com']) {
			const res = await crm(
				env,
				'/companies',
				{ method: 'POST', body: JSON.stringify({ name: `Acme ${domain}`, domain }) },
				cookie,
			);
			expect(res.status).toBe(400);
		}
		// And a blank one is still "not supplied" rather than malformed, as everywhere else here.
		const blank = await createCompany(env, cookie, { name: 'Acme', domain: '   ' });
		expect(blank.domain).toBeNull();
	});

	it('scopes reads to the authorized site', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		await env.CRM_DB.prepare('UPDATE companies SET site_id = ? WHERE id = ?')
			.bind('99999999-9999-4999-8999-999999999999', company.id)
			.run();
		expect((await crm(env, `/companies/${company.id}`, {}, cookie)).status).toBe(404);
	});

	it('rejects a blank name on PATCH while leaving an omitted one alone', async () => {
		// `companies.name` is NOT NULL and it is the display value; blanking it would leave a row
		// nothing can pick out of a list.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		const blank = await crm(
			env,
			`/companies/${company.id}`,
			{ method: 'PATCH', body: JSON.stringify({ name: '  ' }) },
			cookie,
		);
		expect(blank.status).toBe(400);
		const res = await crm(
			env,
			`/companies/${company.id}`,
			{ method: 'PATCH', body: JSON.stringify({ notes: 'renewal in June' }) },
			cookie,
		);
		expect(res.status).toBe(200);
		expect((await res.json()) as { company: { name: string } }).toMatchObject({
			company: { name: 'Acme', notes: 'renewal in June' },
		});
	});
});

describe('the contact to company link', () => {
	it('resolves the company name on read rather than caching it on the contact', async () => {
		// Renaming the company must change what every linked contact reports, with no backfill: the
		// read joins, so there is no copy to go stale in between.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		const contact = await createContact(env, cookie, { name: 'Ada', company_id: company.id });
		const before = (await (await crm(env, `/contacts/${contact.id}`, {}, cookie)).json()) as {
			contact: { company: string | null; company_id: string | null };
		};
		expect(before.contact.company).toBe('Acme');
		expect(before.contact.company_id).toBe(company.id);

		await crm(
			env,
			`/companies/${company.id}`,
			{ method: 'PATCH', body: JSON.stringify({ name: 'Acme Holdings' }) },
			cookie,
		);
		const after = (await (await crm(env, `/contacts/${contact.id}`, {}, cookie)).json()) as {
			contact: { company: string | null };
		};
		expect(after.contact.company).toBe('Acme Holdings');
	});

	it('rejects a company_id belonging to another site, which the foreign key would accept', async () => {
		// The load-bearing scoping test. `company_id` is a real foreign key — both tables are in the
		// CRM database — and the constraint proves only that the row EXISTS. Nothing in it knows the
		// caller has no role on the site that owns it, so a link across that boundary would satisfy
		// the database perfectly and leak a company name into another tenant's contact record.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		await env.CRM_DB.prepare('UPDATE companies SET site_id = ? WHERE id = ?')
			.bind('99999999-9999-4999-8999-999999999999', company.id)
			.run();
		const res = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada', company_id: company.id }) },
			cookie,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'unknown_company' });
	});

	it('rejects a company_id that resolves to nothing', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const res = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada', company_id: 'nope' }) },
			cookie,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'unknown_company' });
	});

	it('refuses to record two employers at once', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		const res = await crm(
			env,
			'/contacts',
			{
				method: 'POST',
				body: JSON.stringify({ name: 'Ada', company: 'Other Inc', company_id: company.id }),
			},
			cookie,
		);
		expect(res.status).toBe(400);
	});

	it('lets a free-text company overwrite a link rather than being silently ignored', async () => {
		// Reads prefer the link, so if writing text left the link in place the caller's edit would
		// appear to do nothing at all.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		const contact = await createContact(env, cookie, { name: 'Ada', company_id: company.id });
		const res = await crm(
			env,
			`/contacts/${contact.id}`,
			{ method: 'PATCH', body: JSON.stringify({ company: 'Other Inc' }) },
			cookie,
		);
		expect(res.status).toBe(200);
		expect((await res.json()) as { contact: { company: string } }).toMatchObject({
			contact: { company: 'Other Inc', company_id: null },
		});
	});

	it('finds linked contacts when searching by company, not just free-text ones', async () => {
		// Linking nulls the free-text column, so a search over the raw column alone would make a
		// contact unfindable by the very company it was just attached to.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		await createContact(env, cookie, { name: 'Ada', company_id: company.id });
		await createContact(env, cookie, { name: 'Grace', company: 'Acme Rivals' });
		await createContact(env, cookie, { name: 'Alan', company: 'Elsewhere' });

		const res = await crm(env, '/companies?q=acm', {}, cookie);
		expect(res.status).toBe(200);
		const found = await crm(env, '/contacts?q=Acme', {}, cookie);
		const { contacts, total } = (await found.json()) as {
			contacts: { name: string }[];
			total: number;
		};
		// Both the linked contact and the free-text one, and not the third.
		expect(total).toBe(2);
		expect(contacts.map((r) => r.name).sort()).toEqual(['Ada', 'Grace']);
	});

	it('lists a company roster without leaking another company or another site', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const acme = await createCompany(env, cookie, { name: 'Acme' });
		const other = await createCompany(env, cookie, { name: 'Other Inc' });
		await createContact(env, cookie, { name: 'Ada', company_id: acme.id });
		await createContact(env, cookie, { name: 'Grace', company_id: acme.id });
		await createContact(env, cookie, { name: 'Alan', company_id: other.id });

		const res = await crm(env, `/companies/${acme.id}/contacts`, {}, cookie);
		const { contacts, total } = (await res.json()) as {
			contacts: { name: string; company: string }[];
			total: number;
		};
		expect(total).toBe(2);
		expect(contacts.map((r) => r.name).sort()).toEqual(['Ada', 'Grace']);
		expect(contacts[0]?.company).toBe('Acme');
	});
});

describe('deleting a company does not delete the people in it', () => {
	it('unlinks its contacts and keeps answering where they work', async () => {
		// A company is an organization, not a data subject. Deleting one is not an erasure request
		// about anybody, so the contacts survive — and the answer to "where does Ada work" has to
		// survive too, or the delete quietly destroyed information nobody asked it to.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		const ada = await createContact(env, cookie, { name: 'Ada', company_id: company.id });
		const grace = await createContact(env, cookie, { name: 'Grace', company_id: company.id });

		const res = await crm(env, `/companies/${company.id}`, { method: 'DELETE' }, cookie);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ deleted: true, contacts_unlinked: 2 });

		for (const id of [ada.id, grace.id]) {
			const after = await crm(env, `/contacts/${id}`, {}, cookie);
			expect(after.status).toBe(200);
			expect((await after.json()) as { contact: { company: string } }).toMatchObject({
				contact: { company: 'Acme', company_id: null },
			});
		}
		expect((await crm(env, `/companies/${company.id}`, {}, cookie)).status).toBe(404);
	});

	it('404s a second delete rather than reporting success twice', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		expect(
			(await crm(env, `/companies/${company.id}`, { method: 'DELETE' }, cookie)).status,
		).toBe(200);
		expect(
			(await crm(env, `/companies/${company.id}`, { method: 'DELETE' }, cookie)).status,
		).toBe(404);
	});
});

describe('the company rollup sums consent, it does not bypass it', () => {
	/** Grant identified-tier consent for `uid` and return the visitor hash it was signed over. */
	async function grantConsentFor(e: TestEnv, uid: string): Promise<string> {
		await e.DB.prepare(
			'INSERT OR REPLACE INTO site_config (site_id, tier, salt_window, updated_at) VALUES (?, ?, ?, ?)',
		)
			.bind(SITE, 'identified', 'day', Date.now())
			.run();
		const { key } = await issueKey(e, SITE, 'server', Date.now());
		const res = await app.request(
			'/api/consent',
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					tier: 'identified',
					salt_window: 'day',
					user_id: uid,
					ip: '203.0.113.9',
					user_agent: 'test-agent',
				}),
			},
			e,
		);
		expect(res.status).toBe(201);
		const row = await e.DB.prepare(
			'SELECT visitor_hash FROM consent_records WHERE site_id = ? AND external_user_id = ?',
		)
			.bind(SITE, uid)
			.first<{ visitor_hash: string }>();
		return row?.visitor_hash as string;
	}

	/** `n` pageviews for one hash. A pageview is `name IS NULL` in this schema. */
	async function seedPageviews(e: TestEnv, hash: string, n: number): Promise<void> {
		const insert = e.DB.prepare(
			`INSERT INTO events (id, site_id, name, hostname, path, referrer, visitor_hash, created_at)
			 VALUES (?, ?, NULL, 'shop.example.com', '/pricing', '', ?, ?)`,
		);
		await e.DB.batch(
			Array.from({ length: n }, (_, i) =>
				insert.bind(crypto.randomUUID(), SITE, hash, Date.now() - i),
			),
		);
	}

	it('counts only the contacts whose consent is currently live, and says how many did not', async () => {
		// The whole safety argument for this endpoint. Grace's events EXIST and her contact row is at
		// the same company as Ada's; the only thing keeping her out of the total is that her grant was
		// revoked. Seeded through a real grant first precisely so the events are reachable if the gate
		// ever stops holding — events under a hash nothing ever consented to would be excluded by
		// accident rather than by the check under test.
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const company = await createCompany(e, cookie, { name: 'Acme' });

		const adaHash = await grantConsentFor(e, 'ada-uid');
		const graceHash = await grantConsentFor(e, 'grace-uid');
		await seedPageviews(e, adaHash, 2);
		await seedPageviews(e, graceHash, 5);

		await createContact(e, cookie, {
			name: 'Ada',
			external_user_id: 'ada-uid',
			company_id: company.id,
		});
		await createContact(e, cookie, {
			name: 'Grace',
			external_user_id: 'grace-uid',
			company_id: company.id,
		});
		// A third contact who could never link at all: no external id, so no consent could exist.
		await createContact(e, cookie, { name: 'Alan', company_id: company.id });

		await e.DB.prepare('UPDATE consent_records SET revoked_at = ? WHERE external_user_id = ?')
			.bind(Date.now(), 'grace-uid')
			.run();

		const res = await crm(e, `/companies/${company.id}/analytics`, {}, cookie);
		const body = (await res.json()) as {
			linked: boolean;
			contacts_total: number;
			contacts_linked: number;
			contacts_truncated: boolean;
			visitor_hashes: number;
			activity: { pageviews: number; total: number };
		};
		expect(body.linked).toBe(true);
		// Ada's two, and not one of Grace's five.
		expect(body.activity.total).toBe(2);
		expect(body.activity.pageviews).toBe(2);
		expect(body.visitor_hashes).toBe(1);
		// And the denominator, so one-of-three cannot be read as the whole company.
		expect(body.contacts_total).toBe(3);
		expect(body.contacts_linked).toBe(1);
		expect(body.contacts_truncated).toBe(false);
	});

	it('ignores a hand-written consent row that is not signed by the deployment', async () => {
		// The batched lookup is new code, so the forgery case is re-proved against it rather than
		// inherited from the single-contact path. The payload is deliberately COMPLETE — right site,
		// right tier, uid-present, pointing at the victim's hash — so every field equality passes and
		// only the signature check can reject it. A sparser payload would fail the field checks and
		// the test would still pass with the crypto disabled.
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const company = await createCompany(e, cookie, { name: 'Acme' });
		const victimHash = 'a'.repeat(64);
		await seedPageviews(e, victimHash, 7);
		await e.DB.prepare(
			`INSERT INTO consent_records
			 (id, site_id, visitor_hash, tier, external_user_id, salt_window, window_key, gpc_at_grant, granted_at, expires_at, revoked_at, statement)
			 VALUES (?, ?, ?, 'identified', ?, 'day', '2026-01-01', 0, ?, NULL, NULL, ?)`,
		)
			.bind(
				crypto.randomUUID(),
				SITE,
				victimHash,
				'mallory-uid',
				Date.now(),
				JSON.stringify({
					payload: {
						iss: 'did:web:example.com',
						site_id: SITE,
						visitor_hash: victimHash,
						tier: 'identified',
						salt_window: 'day',
						window_key: '2026-01-01',
						external_user_id_present: true,
						gpc_at_grant: 0,
						granted_at: new Date().toISOString(),
					},
					proof: { kid: 'forged', alg: 'EdDSA', signature: 'not-a-signature' },
				}),
			)
			.run();
		await createContact(e, cookie, {
			name: 'Mallory',
			external_user_id: 'mallory-uid',
			company_id: company.id,
		});

		const res = await crm(e, `/companies/${company.id}/analytics`, {}, cookie);
		expect(await res.json()).toMatchObject({
			linked: false,
			reason: 'no_linked_contacts',
			contacts_total: 1,
			contacts_linked: 0,
		});
	});

	it('says nothing is linked rather than reporting zeroes that read as no activity', async () => {
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const company = await createCompany(e, cookie, { name: 'Acme' });
		await createContact(e, cookie, { name: 'Ada', company_id: company.id });
		const res = await crm(e, `/companies/${company.id}/analytics`, {}, cookie);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			linked: false,
			reason: 'no_linked_contacts',
			contacts_total: 1,
			contacts_linked: 0,
		});
		expect(body.activity).toBeUndefined();
	});

	it('reports the fan-out cap instead of silently summing a prefix', async () => {
		// Exercised at the data layer with a small limit: the flag has to come from having found one
		// more row than the cap allows, not from the page happening to be full.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		for (const uid of ['a-uid', 'b-uid', 'c-uid']) {
			await createContact(env, cookie, {
				name: uid,
				external_user_id: uid,
				company_id: company.id,
			});
		}
		// One contact who cannot link at all, to prove `contacts_total` counts them and the fan-out
		// list does not.
		await createContact(env, cookie, { name: 'Alan', company_id: company.id });

		const capped = await companyContactLinkage(env.CRM_DB, SITE, company.id, 2);
		expect(capped.contacts_total).toBe(4);
		expect(capped.external_user_ids.length).toBe(2);
		expect(capped.truncated).toBe(true);

		const uncapped = await companyContactLinkage(env.CRM_DB, SITE, company.id, 3);
		expect(uncapped.external_user_ids.length).toBe(3);
		expect(uncapped.truncated).toBe(false);
	});
});

describe('the rollup fan-out stays inside D1 limits', () => {
	it('answers for a company larger than one query can bind', async () => {
		// D1 allows 100 bound parameters per query. The consent lookup binds site_id and `now` on top
		// of one per contact, so a company with 99 linkable contacts asks for 101 and the statement is
		// rejected outright — a hard 500 on exactly the large account that most wants a rollup, while
		// every small company a test would naturally use keeps working.
		// A signing key is required, or the consent lookup returns before it ever builds the query and
		// the fan-out under test never happens.
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const company = await createCompany(e, cookie, { name: 'Acme' });
		const now = Date.now();
		const insert = e.CRM_DB.prepare(
			`INSERT INTO contacts (id, site_id, external_user_id, name, company_id, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'lead', ?, ?)`,
		);
		const n = 99;
		await e.CRM_DB.batch(
			Array.from({ length: n }, (_, i) =>
				insert.bind(
					crypto.randomUUID(),
					SITE,
					`uid-${i}`,
					`Person ${i}`,
					company.id,
					now - i,
					now,
				),
			),
		);
		const res = await crm(e, `/companies/${company.id}/analytics`, {}, cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { contacts_total: number; contacts_linked: number };
		expect(body.contacts_total).toBe(n);
		// Nobody consented, so the honest answer is zero linked — but it has to be an ANSWER.
		expect(body.contacts_linked).toBe(0);
	});
});

describe('a patch cannot strip a contact of every identifier', () => {
	it('refuses to blank email, external id and name all at once', async () => {
		// `ContactCreateSchema` rejects a row with none of the three because such a row "can never be
		// matched, deduped, or erased on request". A PATCH one request later could reach exactly that
		// state, and NULLs are distinct in both unique indexes so nothing downstream would object.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const contact = await createContact(env, cookie, { name: 'Ada', email: 'ada@example.com' });
		const res = await crm(
			env,
			`/contacts/${contact.id}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ name: '', email: '', external_user_id: '' }),
			},
			cookie,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'contact_needs_an_identifier' });
		// And the row is untouched, not half-blanked.
		const after = await crm(env, `/contacts/${contact.id}`, {}, cookie);
		expect((await after.json()) as { contact: { name: string } }).toMatchObject({
			contact: { name: 'Ada', email: 'ada@example.com' },
		});
	});

	it('still lets one identifier be cleared while another survives', async () => {
		// The check is against the MERGED row, not the patch: clearing the email of a contact who
		// still has a name is ordinary editing and must not be blocked.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const contact = await createContact(env, cookie, { name: 'Ada', email: 'ada@example.com' });
		const res = await crm(
			env,
			`/contacts/${contact.id}`,
			{ method: 'PATCH', body: JSON.stringify({ email: '' }) },
			cookie,
		);
		expect(res.status).toBe(200);
		expect((await res.json()) as { contact: { email: null } }).toMatchObject({
			contact: { email: null, name: 'Ada' },
		});
	});
});

describe('the foreign key is a real constraint, not a comment', () => {
	it('refuses a contact pointing at a company that does not exist', async () => {
		// `resolveCompany` is the site-scoped check and this is the backstop underneath it. If D1 did
		// not enforce the constraint, the schema's claim that a bad link "cannot" be written would be
		// decoration, and the race between resolving a company and inserting the row would corrupt
		// data silently instead of failing loudly.
		let message = '';
		try {
			await env.CRM_DB.prepare(
				`INSERT INTO contacts (id, site_id, name, company_id, status, created_at, updated_at)
				 VALUES (?, ?, 'Ada', 'does-not-exist', 'lead', 1, 1)`,
			)
				.bind(crypto.randomUUID(), SITE)
				.run();
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toMatch(/FOREIGN KEY constraint failed/i);
		// And the classifier the route relies on recognises the real error shape, not a guessed one.
		expect(foreignKeyViolation(new Error(message))).toBe(true);
		expect(foreignKeyViolation(new Error('UNIQUE constraint failed: contacts.email'))).toBe(
			false,
		);
	});
});

describe('a capped rollup does not claim what it did not look at', () => {
	it('names the cap rather than asserting nobody is linked', async () => {
		// With the fan-out truncated, "no linked contacts" is a statement about contacts that were
		// never examined. The older ones outside the window may well be linked.
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		const company = await createCompany(e, cookie, { name: 'Acme' });
		const now = Date.now();
		const insert = e.CRM_DB.prepare(
			`INSERT INTO contacts (id, site_id, external_user_id, name, company_id, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'lead', ?, ?)`,
		);
		const n = COMPANY_ROLLUP_MAX_CONTACTS + 1;
		for (let i = 0; i < n; i += 200) {
			await e.CRM_DB.batch(
				Array.from({ length: Math.min(200, n - i) }, (_, j) =>
					insert.bind(
						crypto.randomUUID(),
						SITE,
						`uid-${i + j}`,
						`Person ${i + j}`,
						company.id,
						now - (i + j),
						now,
					),
				),
			);
		}
		const res = await crm(e, `/companies/${company.id}/analytics`, {}, cookie);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			linked: false,
			reason: 'none_linked_within_cap',
			contacts_total: n,
			contacts_considered: COMPANY_ROLLUP_MAX_CONTACTS,
			contacts_truncated: true,
		});
	});
});

describe('a genuine consent statement authorizes only the person it was issued for', () => {
	it('refuses a real, deployment-signed grant filed under another contact id', async () => {
		// The gap signature verification cannot see. The claims name a site, a tier and a hash, but
		// never the uid — `external_user_id_present` is a bit, not a value — so Ada's UNMODIFIED,
		// validly-signed statement satisfies every signature and claim check when copied into a row
		// whose `external_user_id` column says someone else. Nothing is forged, so the crypto has no
		// objection; only recomputing the hash from the row's uid can tell the two apart.
		//
		// The statement is obtained the way an operator really could: the contact export returns it
		// verbatim, deliberately, as cryptographic evidence of what was consented to.
		const e = await withSigningKey(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		await e.DB.prepare(
			'INSERT OR REPLACE INTO site_config (site_id, tier, salt_window, updated_at) VALUES (?, ?, ?, ?)',
		)
			.bind(SITE, 'identified', 'day', Date.now())
			.run();
		const { key } = await issueKey(e, SITE, 'server', Date.now());
		const grant = await app.request(
			'/api/consent',
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					tier: 'identified',
					salt_window: 'day',
					user_id: 'ada-uid',
					ip: '203.0.113.9',
					user_agent: 'test-agent',
				}),
			},
			e,
		);
		expect(grant.status).toBe(201);
		const ada = await e.DB.prepare(
			'SELECT visitor_hash, statement FROM consent_records WHERE site_id = ? AND external_user_id = ?',
		)
			.bind(SITE, 'ada-uid')
			.first<{ visitor_hash: string; statement: string }>();

		// Ada really browsed; these are her events, reachable if the gate fails.
		const insert = e.DB.prepare(
			`INSERT INTO events (id, site_id, name, hostname, path, referrer, visitor_hash, created_at)
			 VALUES (?, ?, NULL, 'shop.example.com', '/pricing', '', ?, ?)`,
		);
		await e.DB.batch([
			insert.bind(crypto.randomUUID(), SITE, ada?.visitor_hash as string, Date.now() - 10),
			insert.bind(crypto.randomUUID(), SITE, ada?.visitor_hash as string, Date.now() - 5),
		]);

		// Ada's statement, byte for byte, filed under Mallory's id.
		await e.DB.prepare(
			`INSERT INTO consent_records
			 (id, site_id, visitor_hash, tier, external_user_id, salt_window, window_key, gpc_at_grant, granted_at, expires_at, revoked_at, statement)
			 SELECT ?, site_id, visitor_hash, tier, ?, salt_window, window_key, gpc_at_grant, granted_at, expires_at, revoked_at, statement
			 FROM consent_records WHERE site_id = ? AND external_user_id = ?`,
		)
			.bind(crypto.randomUUID(), 'mallory-uid', SITE, 'ada-uid')
			.run();

		const mallory = await createContact(e, cookie, {
			name: 'Mallory',
			external_user_id: 'mallory-uid',
		});
		const res = await crm(e, `/contacts/${mallory.id}/analytics`, {}, cookie);
		expect(await res.json()).toMatchObject({ linked: false, reason: 'no_active_consent' });

		// And the rightful owner is unaffected — the check binds the grant, it does not break it.
		const adaContact = await createContact(e, cookie, {
			name: 'Ada',
			external_user_id: 'ada-uid',
		});
		const hers = await crm(e, `/contacts/${adaContact.id}/analytics`, {}, cookie);
		const body = (await hers.json()) as { linked: boolean; activity: { total: number } };
		expect(body.linked).toBe(true);
		expect(body.activity.total).toBe(2);
	});
});

describe('the PII routes are bounded, not just authenticated', () => {
	/** An env whose rate limiter denies everything, which is how a wired-up limiter is distinguished
	 * from one that was never attached. The real binding is absent in tests, so the middleware
	 * no-ops and its presence is otherwise unobservable. */
	function denyingLimiter(e: TestEnv): TestEnv {
		return { ...e, RATE_LIMITER: { limit: async () => ({ success: false }) } } as TestEnv;
	}

	it('rate limits an authenticated operator, and only after authenticating them', async () => {
		const e = denyingLimiter(env);
		const cookie = await operator(e, 'analyst@example.com', 'analyst');
		const limited = await crm(e, '/contacts', {}, cookie);
		expect(limited.status).toBe(429);
		expect(limited.headers.get('Retry-After')).toBe('60');

		// Auth still runs first: an anonymous caller is rejected as unauthorized rather than being
		// told it was rate limited, so an unauthenticated flood cannot consume anyone's bucket.
		const anonymous = await crm(e, '/contacts');
		expect(anonymous.status).toBe(401);

		// A viewer is refused on role, also before the limiter.
		const viewerCookie = await operator(e, 'viewer@example.com', 'viewer');
		expect((await crm(e, '/contacts', {}, viewerCookie)).status).toBe(403);
	});

	it('covers the company routes too, not just contacts', async () => {
		const e = denyingLimiter(env);
		const cookie = await operator(e, 'admin@example.com', 'admin');
		expect((await crm(e, '/companies', {}, cookie)).status).toBe(429);
	});

	it('refuses an oversized write body', async () => {
		// The global bodyLimit is scoped to /api/collect, so before this the one route group storing
		// personal data was the only one accepting an unbounded upload.
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const res = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada', notes: 'x'.repeat(50_000) }) },
			cookie,
		);
		expect(res.status).toBe(413);
	});

	it('refuses to page arbitrarily deep', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		expect((await crm(env, `/contacts?offset=${CRM_MAX_OFFSET + 1}`, {}, cookie)).status).toBe(
			400,
		);
		// The ceiling itself is still reachable, so this is a bound and not an off-by-one.
		expect((await crm(env, `/contacts?offset=${CRM_MAX_OFFSET}`, {}, cookie)).status).toBe(200);
	});
});

describe('deals', () => {
	it('refuses a deal with no name', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const res = await crm(env, '/deals', { method: 'POST', body: JSON.stringify({}) }, cookie);
		expect(res.status).toBe(400);
	});

	it('requires value and currency together, in either direction', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const valueOnly = await crm(
			env,
			'/deals',
			{ method: 'POST', body: JSON.stringify({ name: 'Acme renewal', value: 500_00 }) },
			cookie,
		);
		expect(valueOnly.status).toBe(400);
		const currencyOnly = await crm(
			env,
			'/deals',
			{ method: 'POST', body: JSON.stringify({ name: 'Acme renewal', currency: 'USD' }) },
			cookie,
		);
		expect(currencyOnly.status).toBe(400);
		const both = await crm(
			env,
			'/deals',
			{
				method: 'POST',
				body: JSON.stringify({ name: 'Acme renewal', value: 500_00, currency: 'usd' }),
			},
			cookie,
		);
		expect(both.status).toBe(201);
		// Uppercased on the way in, so `usd` and `USD` land in the same pipeline bucket.
		expect(await both.json()).toMatchObject({ deal: { currency: 'USD' } });
	});

	it('defaults to the lead stage and lets a PATCH move it through the pipeline', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const deal = await createDeal(env, cookie, { name: 'Acme renewal' });
		expect(deal.stage).toBe('lead');
		const res = await crm(
			env,
			`/deals/${deal.id}`,
			{ method: 'PATCH', body: JSON.stringify({ stage: 'won' }) },
			cookie,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ deal: { stage: 'won' } });
	});

	it('scopes reads to the authorized site', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const deal = await createDeal(env, cookie, { name: 'Acme renewal' });
		await env.CRM_DB.prepare('UPDATE deals SET site_id = ? WHERE id = ?')
			.bind('99999999-9999-4999-8999-999999999999', deal.id)
			.run();
		expect((await crm(env, `/deals/${deal.id}`, {}, cookie)).status).toBe(404);
	});

	it('links a deal to a company and a contact on the same site, by id', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		const contact = await createContact(env, cookie, { name: 'Ada' });
		const deal = await createDeal(env, cookie, {
			name: 'Acme renewal',
			company_id: company.id,
			contact_id: contact.id,
		});
		const res = await crm(env, `/deals/${deal.id}`, {}, cookie);
		expect(await res.json()).toMatchObject({
			deal: { company_id: company.id, contact_id: contact.id },
		});
	});

	it('rejects a company_id or contact_id that resolves to nothing', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const badCompany = await crm(
			env,
			'/deals',
			{ method: 'POST', body: JSON.stringify({ name: 'x', company_id: 'nope' }) },
			cookie,
		);
		expect(badCompany.status).toBe(400);
		const badContact = await crm(
			env,
			'/deals',
			{ method: 'POST', body: JSON.stringify({ name: 'x', contact_id: 'nope' }) },
			cookie,
		);
		expect(badContact.status).toBe(400);
	});

	it('rejects a company_id belonging to another site, which the foreign key would accept', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		await env.CRM_DB.prepare('UPDATE companies SET site_id = ? WHERE id = ?')
			.bind('99999999-9999-4999-8999-999999999999', company.id)
			.run();
		const res = await crm(
			env,
			'/deals',
			{ method: 'POST', body: JSON.stringify({ name: 'x', company_id: company.id }) },
			cookie,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'unknown_company' });
	});

	it('filters by stage, company and a substring of the name', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		await createDeal(env, cookie, {
			name: 'Acme renewal',
			company_id: company.id,
			stage: 'won',
		});
		await createDeal(env, cookie, { name: 'Acme upsell', company_id: company.id });
		await createDeal(env, cookie, { name: 'Globex trial' });

		type DealsPage = { deals: { name: string }[]; total: number };

		const byStage = await crm(env, '/deals?stage=won', {}, cookie);
		expect(((await byStage.json()) as DealsPage).total).toBe(1);

		const byCompany = await crm(env, `/deals?company_id=${company.id}`, {}, cookie);
		expect(((await byCompany.json()) as DealsPage).total).toBe(2);

		const byName = await crm(env, '/deals?q=upsell', {}, cookie);
		const found = (await byName.json()) as DealsPage;
		expect(found.total).toBe(1);
		expect(found.deals[0]?.name).toBe('Acme upsell');
	});

	it('really deletes a deal and 404s a second delete', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const deal = await createDeal(env, cookie, { name: 'Acme renewal' });
		expect((await crm(env, `/deals/${deal.id}`, { method: 'DELETE' }, cookie)).status).toBe(
			200,
		);
		expect((await crm(env, `/deals/${deal.id}`, { method: 'DELETE' }, cookie)).status).toBe(
			404,
		);
	});
});

describe('deleting a contact or company unlinks its deals rather than destroying them', () => {
	it('nulls contact_id when the contact is erased, and the deal survives', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const contact = await createContact(env, cookie, { name: 'Ada' });
		const deal = await createDeal(env, cookie, {
			name: 'Acme renewal',
			contact_id: contact.id,
		});

		const res = await crm(env, `/contacts/${contact.id}`, { method: 'DELETE' }, cookie);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ deleted: true, deals_unlinked: 1 });

		const after = await crm(env, `/deals/${deal.id}`, {}, cookie);
		expect(after.status).toBe(200);
		expect(await after.json()).toMatchObject({ deal: { contact_id: null } });
	});

	it('nulls company_id when the company is deleted, and reports how many deals were unlinked', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		const company = await createCompany(env, cookie, { name: 'Acme' });
		const dealA = await createDeal(env, cookie, { name: 'Renewal', company_id: company.id });
		const dealB = await createDeal(env, cookie, { name: 'Upsell', company_id: company.id });

		const res = await crm(env, `/companies/${company.id}`, { method: 'DELETE' }, cookie);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ deleted: true, deals_unlinked: 2 });

		for (const id of [dealA.id, dealB.id]) {
			const after = await crm(env, `/deals/${id}`, {}, cookie);
			expect(await after.json()).toMatchObject({ deal: { company_id: null } });
		}
	});
});

describe('the deal pipeline is summed per currency', () => {
	it('groups open and won value separately, and excludes lost and unpriced deals', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		await createDeal(env, cookie, {
			name: 'A',
			stage: 'qualified',
			value: 100_00,
			currency: 'USD',
		});
		await createDeal(env, cookie, {
			name: 'B',
			stage: 'negotiation',
			value: 200_00,
			currency: 'USD',
		});
		await createDeal(env, cookie, { name: 'C', stage: 'won', value: 300_00, currency: 'USD' });
		// Excluded: a terminal loss, and a deal nobody has priced yet.
		await createDeal(env, cookie, { name: 'D', stage: 'lost', value: 400_00, currency: 'USD' });
		await createDeal(env, cookie, { name: 'E', stage: 'qualified' });
		// A second currency stays in its own bucket rather than being added to the first.
		await createDeal(env, cookie, {
			name: 'F',
			stage: 'qualified',
			value: 50_00,
			currency: 'EUR',
		});

		const res = await crm(env, '/pipeline', {}, cookie);
		expect(res.status).toBe(200);
		const { pipeline } = (await res.json()) as {
			pipeline: {
				currency: string;
				open_value: number;
				open_count: number;
				won_value: number;
				won_count: number;
			}[];
		};
		expect(pipeline).toEqual([
			{ currency: 'EUR', open_value: 50_00, open_count: 1, won_value: 0, won_count: 0 },
			{ currency: 'USD', open_value: 300_00, open_count: 2, won_value: 300_00, won_count: 1 },
		]);
	});

	it('reports nothing for a site with no priced deals, rather than a bucket of zeroes', async () => {
		const cookie = await operator(env, 'admin@example.com', 'admin');
		await createDeal(env, cookie, { name: 'Unpriced' });
		const res = await crm(env, '/pipeline', {}, cookie);
		expect(await res.json()).toEqual({ pipeline: [] });
	});
});
