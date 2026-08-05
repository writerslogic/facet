// The CRM audit log. What matters here is not that entries can be written and listed, but the four
// properties that make the log worth having: that EVERY route writes one, that it is written before
// the handler so nothing can happen unrecorded, that a request which was never authorized writes
// nothing, and that deleting the contact does not delete the evidence.
//
// The route-coverage test is deliberately table-driven over `CRM_AUDIT_ACTIONS`: a new CRM route that
// is given a role but no audited action cannot compile, and an action added to the set with no route
// behind it fails here.

import { env } from 'cloudflare:test';
import { CRM_AUDIT_ACTIONS } from '@facet/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
	SESSION_COOKIE,
	signSession,
	upsertUserByEmail,
	userMemberships,
} from '../src/lib/accounts.js';
import { issueKey } from '../src/lib/apikeys.js';
import { enforceCrmAuditRetention } from '../src/lib/retention.js';

const SITE = '77777777-7777-4777-8777-777777777777';
const OTHER_SITE = '88888888-8888-4888-8888-888888888888';
const DAY = 86_400_000;
const app = createApp();

type TestEnv = typeof env;

interface AuditRow {
	id: string;
	site_id: string;
	actor_user_id: string;
	actor_role: string;
	action: string;
	target_id: string | null;
	occurred_at: number;
}

/** An env with the CRM binding removed — what a deployment that never created the database is. */
function unbound(e: TestEnv): TestEnv {
	const { CRM_DB: Omitted, ...rest } = e;
	return rest as unknown as TestEnv;
}

async function seedSite(e: TestEnv): Promise<void> {
	await e.DB.prepare(
		'INSERT OR IGNORE INTO sites (id, name, domain, created_at) VALUES (?, ?, ?, ?)',
	)
		.bind(SITE, 'Test', 'shop.example.com', Date.now())
		.run();
}

/** Create an operator with `role` on the team owning SITE; returns their id and session cookie. */
async function operator(
	e: TestEnv,
	email: string,
	role: string,
): Promise<{ id: string; cookie: string }> {
	const now = Date.now();
	const user = await upsertUserByEmail(e, email, now);
	const teamId = (await userMemberships(e, user.id))[0]?.teamId as string;
	await e.DB.prepare('UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?')
		.bind(role, teamId, user.id)
		.run();
	await e.DB.prepare('UPDATE sites SET team_id = ? WHERE id = ?').bind(teamId, SITE).run();
	const secret = e.SESSION_SECRET as string;
	return { id: user.id, cookie: `${SESSION_COOKIE}=${await signSession(user.id, secret, now)}` };
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

/** The raw log, oldest first. Read straight from D1 rather than through the API, so the assertions
 * do not depend on the very route they are checking. */
async function log(e: TestEnv): Promise<AuditRow[]> {
	const { results } = await (e.CRM_DB as D1Database)
		.prepare('SELECT * FROM crm_audit_log ORDER BY occurred_at, rowid')
		.all<AuditRow>();
	return results ?? [];
}

beforeEach(async () => {
	await seedSite(env);
});

describe('every route records the access before it performs it', () => {
	it('writes one entry per authorized request, naming the action and the record', async () => {
		const { id: userId, cookie } = await operator(env, 'admin@example.com', 'admin');

		const created = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada', external_user_id: 'ada-uid' }) },
			cookie,
		);
		expect(created.status).toBe(201);
		const contactId = ((await created.json()) as { contact: { id: string } }).contact.id;

		const madeCompany = await crm(
			env,
			'/companies',
			{ method: 'POST', body: JSON.stringify({ name: 'Acme' }) },
			cookie,
		);
		expect(madeCompany.status).toBe(201);
		const companyId = ((await madeCompany.json()) as { company: { id: string } }).company.id;

		// The rest of the surface, in one pass. `contact.create` and `company.create` are already done
		// above because the ids they mint are what the other routes address.
		const rest: [string, RequestInit, string, string | null][] = [
			['/contacts', {}, 'contact.list', null],
			[`/contacts/${contactId}`, {}, 'contact.read', contactId],
			[
				`/contacts/${contactId}`,
				{ method: 'PATCH', body: JSON.stringify({ title: 'CTO' }) },
				'contact.update',
				contactId,
			],
			[`/contacts/${contactId}/analytics`, {}, 'contact.analytics', contactId],
			[`/contacts/${contactId}/export`, {}, 'contact.export', contactId],
			['/companies', {}, 'company.list', null],
			[`/companies/${companyId}`, {}, 'company.read', companyId],
			[
				`/companies/${companyId}`,
				{ method: 'PATCH', body: JSON.stringify({ status: 'active' }) },
				'company.update',
				companyId,
			],
			[`/companies/${companyId}/contacts`, {}, 'company.contacts', companyId],
			[`/companies/${companyId}/analytics`, {}, 'company.analytics', companyId],
			['/audit', {}, 'audit.read', null],
			[`/contacts/${contactId}`, { method: 'DELETE' }, 'contact.delete', contactId],
			[`/companies/${companyId}`, { method: 'DELETE' }, 'company.delete', companyId],
		];
		for (const [path, init, ,] of rest) {
			expect((await crm(env, path, init, cookie)).status).toBe(200);
		}

		const entries = await log(env);
		expect(entries.map((e) => e.action)).toEqual([
			'contact.create',
			'company.create',
			...rest.map(([, , action]) => action),
		]);
		expect(entries.map((e) => e.target_id)).toEqual([
			null,
			null,
			...rest.map(([, , , target]) => target),
		]);
		// Every entry attributes the request to the session that made it, under the role it was
		// authorized with — not the role that user holds when the log is read.
		expect(entries.every((e) => e.actor_user_id === userId && e.actor_role === 'admin')).toBe(
			true,
		);
		expect(entries.every((e) => e.site_id === SITE)).toBe(true);
	});

	it('records every action the vocabulary declares, and declares every action it records', async () => {
		// The set is closed so the log can be filtered by equality; a route with no action, or an
		// action with no route, makes it a set of names that means nothing.
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		const contact = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada' }) },
			cookie,
		);
		const contactId = ((await contact.json()) as { contact: { id: string } }).contact.id;
		const company = await crm(
			env,
			'/companies',
			{ method: 'POST', body: JSON.stringify({ name: 'Acme' }) },
			cookie,
		);
		const companyId = ((await company.json()) as { company: { id: string } }).company.id;
		for (const path of [
			'/contacts',
			`/contacts/${contactId}`,
			`/contacts/${contactId}/analytics`,
			`/contacts/${contactId}/export`,
			'/companies',
			`/companies/${companyId}`,
			`/companies/${companyId}/contacts`,
			`/companies/${companyId}/analytics`,
			'/audit',
		]) {
			await crm(env, path, {}, cookie);
		}
		await crm(env, `/contacts/${contactId}`, { method: 'PATCH', body: '{}' }, cookie);
		await crm(env, `/companies/${companyId}`, { method: 'PATCH', body: '{}' }, cookie);
		await crm(env, `/contacts/${contactId}`, { method: 'DELETE' }, cookie);
		await crm(env, `/companies/${companyId}`, { method: 'DELETE' }, cookie);

		const recorded = new Set((await log(env)).map((e) => e.action));
		expect([...recorded].sort()).toEqual([...CRM_AUDIT_ACTIONS].sort());
	});

	it('records a read that then finds nothing, because probing ids is what a log should show', async () => {
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		const missing = '00000000-0000-4000-8000-000000000000';
		expect((await crm(env, `/contacts/${missing}`, {}, cookie)).status).toBe(404);
		const entries = await log(env);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.action).toBe('contact.read');
		expect(entries[0]?.target_id).toBe(missing);
	});
});

describe('an unauthorized request is not an access', () => {
	it('records nothing for a caller with no session, the wrong role, or an API key', async () => {
		const { cookie } = await operator(env, 'viewer@example.com', 'viewer');
		expect((await crm(env, '/contacts')).status).toBe(401);
		expect((await crm(env, '/contacts', {}, cookie)).status).toBe(403);

		// The load-bearing one: a clk_ key is handed out on purpose, and it must not be able to write
		// into the log any more than it can read a contact.
		const { key } = await issueKey(env, SITE, null, Date.now());
		for (const path of ['/contacts', '/audit']) {
			const withKey = await crm(env, path, { headers: { Authorization: `Bearer ${key}` } });
			expect(withKey.status, path).toBe(401);
		}

		expect(await log(env)).toHaveLength(0);
	});

	it('records nothing for a request the rate limiter shed', async () => {
		// Otherwise one stolen session could fill the audit table with entries for requests it was
		// never allowed to make — the log's own denial of service.
		const denying = {
			...env,
			RATE_LIMITER: { limit: async () => ({ success: false }) },
		} as TestEnv;
		const { cookie } = await operator(denying, 'admin@example.com', 'admin');
		expect((await crm(denying, '/contacts', {}, cookie)).status).toBe(429);
		expect(await log(denying)).toHaveLength(0);
	});

	it('answers 501 without a CRM database, having nowhere to record anything', async () => {
		const e = unbound(env);
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		expect((await crm(e, '/audit', {}, cookie)).status).toBe(501);
	});
});

describe('the log cannot be skipped', () => {
	/** Break the audit table specifically, leaving the contact store intact. This is what a D1 failure
	 * on the log write looks like from the route's side. */
	async function breakTheLog(e: TestEnv): Promise<void> {
		await (e.CRM_DB as D1Database).exec('DROP TABLE crm_audit_log');
	}

	async function contactCount(e: TestEnv): Promise<number> {
		const row = await (e.CRM_DB as D1Database)
			.prepare('SELECT count(*) AS n FROM contacts')
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	it('fails a read closed rather than disclosing what it could not record', async () => {
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		const created = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada', email: 'ada@example.com' }) },
			cookie,
		);
		const contactId = ((await created.json()) as { contact: { id: string } }).contact.id;
		await breakTheLog(env);

		const res = await crm(env, `/contacts/${contactId}`, {}, cookie);
		expect(res.status).toBe(500);
		// The name and email never left the Worker.
		expect(await res.text()).not.toContain('ada@example.com');
	});

	it('fails a delete closed, leaving the contact for a retry that can be recorded', async () => {
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		const created = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada' }) },
			cookie,
		);
		const contactId = ((await created.json()) as { contact: { id: string } }).contact.id;
		await breakTheLog(env);

		expect(
			(await crm(env, `/contacts/${contactId}`, { method: 'DELETE' }, cookie)).status,
		).toBe(500);
		// An unrecorded deletion is the one outcome an audit log exists to prevent; the row is still
		// there, so the operator can retry once the log is writable again.
		expect(await contactCount(env)).toBe(1);
	});
});

describe('the log outlives what it describes', () => {
	it("keeps a contact's entries after the contact is erased", async () => {
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		const created = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada', external_user_id: 'ada-uid' }) },
			cookie,
		);
		const contactId = ((await created.json()) as { contact: { id: string } }).contact.id;
		await crm(env, `/contacts/${contactId}/export`, {}, cookie);
		expect(
			(await crm(env, `/contacts/${contactId}`, { method: 'DELETE' }, cookie)).status,
		).toBe(200);

		// The entries name the contact by id and hold none of its fields, so what survives is a record
		// of what operators did — not personal data the erasure should have reached. A log an operator
		// can clear by deleting the row is not evidence of anything.
		const entries = await log(env);
		expect(entries.map((e) => e.action)).toEqual([
			'contact.create',
			'contact.export',
			'contact.delete',
		]);
		expect(entries.every((e) => e.target_id === null || e.target_id === contactId)).toBe(true);
		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain('Ada');
		expect(serialized).not.toContain('ada-uid');
	});
});

describe('retention', () => {
	/** Backdate every entry by `days`, standing in for a log that has been running that long. */
	async function ageLog(e: TestEnv, days: number): Promise<void> {
		await (e.CRM_DB as D1Database)
			.prepare('UPDATE crm_audit_log SET occurred_at = occurred_at - ?')
			.bind(days * DAY)
			.run();
	}

	async function seedEntry(e: TestEnv): Promise<string> {
		const { cookie } = await operator(e, 'admin@example.com', 'admin');
		const created = await crm(
			e,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada' }) },
			cookie,
		);
		return ((await created.json()) as { contact: { id: string } }).contact.id;
	}

	it('purges entries past the window and leaves the contacts they name alone', async () => {
		await seedEntry(env);
		await ageLog(env, 400);
		expect(await enforceCrmAuditRetention(env, Date.now())).toBe(1);
		expect(await log(env)).toHaveLength(0);
		// Contacts are business records with their own lifecycle and are on NO schedule; only the log
		// ages out.
		const row = await (env.CRM_DB as D1Database)
			.prepare('SELECT count(*) AS n FROM contacts')
			.first<{ n: number }>();
		expect(row?.n).toBe(1);
	});

	it('keeps an entry inside the default window', async () => {
		await seedEntry(env);
		await ageLog(env, 300);
		await enforceCrmAuditRetention(env, Date.now());
		expect(await log(env)).toHaveLength(1);
	});

	it('honours a configured window', async () => {
		const e = { ...env, CRM_AUDIT_RETENTION_DAYS: '2' } as TestEnv;
		await seedEntry(e);
		await ageLog(e, 3);
		await enforceCrmAuditRetention(e, Date.now());
		expect(await log(e)).toHaveLength(0);
	});

	it('falls back to the default rather than erasing the log on a bad value', async () => {
		// A window of 0 or less puts the cutoff at or after now, so every run would wipe the entire
		// log — including the entries written seconds earlier.
		for (const bad of ['0', '-5', 'not-a-number', '']) {
			const e = { ...env, CRM_AUDIT_RETENTION_DAYS: bad } as TestEnv;
			await (e.CRM_DB as D1Database).exec('DELETE FROM crm_audit_log');
			await seedEntry(e);
			await enforceCrmAuditRetention(e, Date.now());
			expect(await log(e), `window=${bad}`).toHaveLength(1);
		}
	});

	it('does nothing on a deployment with no CRM database', async () => {
		expect(await enforceCrmAuditRetention(unbound(env), Date.now())).toBe(0);
	});
});

describe('GET /api/crm/audit', () => {
	it('is admin-only, because it reports on colleagues rather than on contacts', async () => {
		const { cookie } = await operator(env, 'analyst@example.com', 'analyst');
		expect((await crm(env, '/audit', {}, cookie)).status).toBe(403);
		// And the refusal wrote nothing: the gate records only what it authorized.
		expect(await log(env)).toHaveLength(0);
	});

	it("returns one site's entries, newest first, filtered by action, actor and target", async () => {
		const { id: userId, cookie } = await operator(env, 'admin@example.com', 'admin');
		const created = await crm(
			env,
			'/contacts',
			{ method: 'POST', body: JSON.stringify({ name: 'Ada' }) },
			cookie,
		);
		const contactId = ((await created.json()) as { contact: { id: string } }).contact.id;
		await crm(env, `/contacts/${contactId}`, {}, cookie);
		// Another site's entry, written straight into the table: the list is scoped by the authorized
		// site exactly as every other CRM read is.
		await (env.CRM_DB as D1Database)
			.prepare(
				'INSERT INTO crm_audit_log (id, site_id, actor_user_id, actor_role, action, target_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			)
			.bind('other', OTHER_SITE, userId, 'admin', 'contact.read', contactId, Date.now())
			.run();

		const res = await crm(env, '/audit', {}, cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: AuditRow[]; total: number; role: string };
		expect(body.role).toBe('admin');
		// Newest first: this very request, then the read, then the create.
		expect(body.entries.map((e) => e.action)).toEqual([
			'audit.read',
			'contact.read',
			'contact.create',
		]);
		expect(body.total).toBe(3);
		expect(body.entries.every((e) => e.site_id === SITE)).toBe(true);

		const byAction = (await (
			await crm(env, '/audit?action=contact.read', {}, cookie)
		).json()) as { entries: AuditRow[]; total: number };
		expect(byAction.total).toBe(1);
		expect(byAction.entries[0]?.target_id).toBe(contactId);

		const byTarget = (await (
			await crm(env, `/audit?target_id=${contactId}`, {}, cookie)
		).json()) as { total: number };
		expect(byTarget.total).toBe(1);

		const byActor = (await (
			await crm(env, `/audit?actor_user_id=${userId}`, {}, cookie)
		).json()) as { total: number };
		// Every entry on this site is this operator's; the other site's is still excluded.
		expect(byActor.total).toBe(6);

		const noneSuch = (await (
			await crm(env, '/audit?actor_user_id=nobody', {}, cookie)
		).json()) as { total: number; entries: AuditRow[] };
		expect(noneSuch.total).toBe(0);
		expect(noneSuch.entries).toEqual([]);
	});

	it('rejects an action outside the closed set', async () => {
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		expect((await crm(env, '/audit?action=contact.everything', {}, cookie)).status).toBe(400);
	});

	it('reports the horizon, so an empty page cannot read as "this never happened"', async () => {
		// The log is the one CRM table that ages out. Without the window, "no entries" is
		// indistinguishable from "it aged out" — and an auditor concluding the former when the latter
		// is true has drawn exactly the wrong conclusion from an access log.
		const e = { ...env, CRM_AUDIT_RETENTION_DAYS: '30' } as TestEnv;
		const { cookie } = await operator(e, 'admin@example.com', 'admin');
		const before = Date.now();
		const body = (await (await crm(e, '/audit', {}, cookie)).json()) as {
			retention_days: number;
			covers_since: number;
		};
		const after = Date.now();
		expect(body.retention_days).toBe(30);
		// Bracketed by the request itself: the horizon is 30 days behind the moment the server
		// answered, which lies between these two readings.
		expect(body.covers_since).toBeGreaterThanOrEqual(before - 30 * DAY);
		expect(body.covers_since).toBeLessThanOrEqual(after - 30 * DAY);
	});

	it('reports the default horizon when the deployment configured none', async () => {
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		const body = (await (await crm(env, '/audit', {}, cookie)).json()) as {
			retention_days: number;
		};
		expect(body.retention_days).toBe(365);
	});

	it('names the actor, because an id nobody can resolve is not accountability', async () => {
		const { id: userId, cookie } = await operator(env, 'admin@example.com', 'admin');
		const res = await crm(env, '/audit', {}, cookie);
		const body = (await res.json()) as {
			entries: (AuditRow & { actor_email: string | null })[];
		};
		expect(body.entries[0]?.actor_user_id).toBe(userId);
		expect(body.entries[0]?.actor_email).toBe('admin@example.com');
	});

	it('keeps the entry when the account behind it is gone, with no email to give it', async () => {
		const { id: userId, cookie } = await operator(env, 'admin@example.com', 'admin');
		await crm(env, '/contacts', {}, cookie);
		// A closed account cannot be given a name back, and inventing one would be worse than the
		// blank. The id stays either way, so the entry still says *someone specific* did this.
		await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
		// The session outlives the row, which is what makes this reachable at all: sessions are
		// stateless and verify against the secret, not against a user lookup.
		const res = await crm(env, '/audit', {}, cookie);
		const body = (await res.json()) as {
			entries: (AuditRow & { actor_email: string | null })[];
		};
		expect(body.entries.length).toBeGreaterThan(0);
		expect(body.entries.every((e) => e.actor_user_id === userId)).toBe(true);
		expect(body.entries.every((e) => e.actor_email === null)).toBe(true);
	});

	it('resolves a full page of distinct actors', async () => {
		// A page caps at 100 entries, so it can name 100 distinct operators — and D1 refuses a
		// statement carrying more than 100 bound parameters. One lookup for the whole page therefore
		// sits EXACTLY on that ceiling, correct only while two unrelated limits keep their current
		// relationship, which is why the resolve chunks at the same margin as every other IN list.
		//
		// 99 seeded, because reading the log writes an entry of its own: this page carries exactly the
		// 100 distinct actors that are the most a single page can ever name.
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		const now = Date.now();
		const users: D1PreparedStatement[] = [];
		const entries: D1PreparedStatement[] = [];
		for (let i = 0; i < 99; i++) {
			const id = `actor-${i}`;
			users.push(
				env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(
					id,
					`op${i}@example.com`,
					now,
				),
			);
			entries.push(
				(env.CRM_DB as D1Database)
					.prepare(
						'INSERT INTO crm_audit_log (id, site_id, actor_user_id, actor_role, action, target_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
					)
					.bind(`entry-${i}`, SITE, id, 'analyst', 'contact.list', null, now + i),
			);
		}
		await env.DB.batch(users);
		await (env.CRM_DB as D1Database).batch(entries);

		const res = await crm(env, '/audit?limit=100', {}, cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			entries: (AuditRow & { actor_email: string | null })[];
		};
		expect(body.entries).toHaveLength(100);
		const resolved = body.entries.filter((e) => e.actor_user_id.startsWith('actor-'));
		expect(resolved).toHaveLength(99);
		expect(
			resolved.every((e) => e.actor_email === `op${e.actor_user_id.slice(6)}@example.com`),
		).toBe(true);
	});

	it('pages within the same bounds as every other CRM list', async () => {
		const { cookie } = await operator(env, 'admin@example.com', 'admin');
		for (let i = 0; i < 3; i++) {
			await crm(env, '/contacts', {}, cookie);
		}
		const page = (await (await crm(env, '/audit?limit=2', {}, cookie)).json()) as {
			entries: AuditRow[];
			total: number;
		};
		expect(page.entries).toHaveLength(2);
		expect(page.total).toBeGreaterThan(2);
		expect((await crm(env, '/audit?limit=101', {}, cookie)).status).toBe(400);
	});
});
