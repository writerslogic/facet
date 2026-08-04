// CRM foundation + contacts. The assertions that matter here are the boundary ones, not the CRUD:
// that the extension does not exist without its binding, that an API key can never reach contact
// PII, that the analytics link is authorized by a SIGNED consent statement rather than by a column,
// that retention severs that link on its own, and that deleting a contact really deletes.

import { env } from 'cloudflare:test';
import { generateSigningJwk } from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CONTACT_EXPORT_MAX_EVENTS } from '../src/db/contact-analytics.js';
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
	return `${SESSION_COOKIE}=${await signSession(user.id, secret, now)}`;
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

beforeEach(async () => {
	await seedSite(env);
});

describe('the binding is the gate', () => {
	it('501s every CRM route when CRM_DB is unbound, before authenticating', async () => {
		const e = unbound(env);
		for (const path of ['/contacts', '/contacts/anything', '/contacts/anything/export']) {
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

	it('gives a viewer no CRM access at all', async () => {
		const cookie = await operator(env, 'viewer@example.com', 'viewer');
		expect((await crm(env, '/contacts', {}, cookie)).status).toBe(403);
	});

	it('blocks an operator with no role on the site', async () => {
		await operator(env, 'owner@example.com', 'owner');
		const now = Date.now();
		const outsider = await upsertUserByEmail(env, 'outsider@example.com', now);
		const cookie = `${SESSION_COOKIE}=${await signSession(outsider.id, env.SESSION_SECRET as string, now)}`;
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
