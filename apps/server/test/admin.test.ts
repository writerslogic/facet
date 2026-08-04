// Admin sites & keys endpoints: create/list sites, issue/list(no hash)/revoke keys, behind requireAdmin.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { siteRole, upsertUserByEmail, userMemberships } from '../src/lib/accounts.js';

const ADMIN = 'Bearer test-admin-token';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_HEADERS = {
	Authorization: ADMIN,
	'content-type': 'application/json',
};

function admin(path: string, init: RequestInit = {}) {
	return createApp().request(path, init, env);
}

async function createSite(name = 'Acme', domain = 'acme.com'): Promise<{ id: string }> {
	const res = await admin('/api/sites', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ name, domain }),
	});
	return ((await res.json()) as { site: { id: string } }).site;
}

describe('admin sites & keys', () => {
	it('creates a site and lists it', async () => {
		const res = await admin('/api/sites', {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ name: 'Acme', domain: 'acme.com' }),
		});
		expect(res.status).toBe(201);
		const { site } = (await res.json()) as {
			site: { id: string; name: string };
		};
		expect(site.id).toMatch(UUID_RE);
		expect(site.name).toBe('Acme');

		const list = await admin('/api/sites', {
			headers: { Authorization: ADMIN },
		});
		const { sites } = (await list.json()) as { sites: { id: string }[] };
		expect(sites.some((s) => s.id === site.id)).toBe(true);
	});

	it('issues, lists without a hash, and revokes a key', async () => {
		const site = await createSite('S', 's.com');
		const issueRes = await admin('/api/keys', {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ site_id: site.id, label: 'ci' }),
		});
		expect(issueRes.status).toBe(201);
		const issued = (await issueRes.json()) as { id: string; key: string };
		expect(issued.id).toMatch(UUID_RE);
		expect(issued.key.startsWith('clk_')).toBe(true);

		const list = await admin(`/api/keys?site_id=${site.id}`, {
			headers: { Authorization: ADMIN },
		});
		const { keys } = (await list.json()) as { keys: Record<string, unknown>[] };
		expect(keys).toHaveLength(1);
		expect(keys[0]).not.toHaveProperty('key_hash');
		expect(keys[0]).not.toHaveProperty('key');

		const del = await admin(`/api/keys/${issued.id}?site_id=${site.id}`, {
			method: 'DELETE',
			headers: { Authorization: ADMIN },
		});
		expect(del.status).toBe(200);
		expect(await del.json()).toEqual({ deleted: true });

		const del2 = await admin(`/api/keys/${issued.id}?site_id=${site.id}`, {
			method: 'DELETE',
			headers: { Authorization: ADMIN },
		});
		expect(del2.status).toBe(404);
		expect(await del2.json()).toEqual({ error: 'not_found' });
	});

	// Until PATCH /api/sites/:id/team existed, `sites.team_id` was writable by nothing in the shipped
	// code — so `siteRole` always returned null, the dashboard-session branch of `requireSiteAccess`
	// was unreachable in production, and the accounts/RBAC surface could only be exercised by a test
	// setting the column with raw SQL. These cover the endpoint that closes that.
	it('assigns a site to a team, which is what makes session RBAC reachable', async () => {
		const site = await createSite('Teamed', 'teamed.com');
		const now = Date.now();
		const user = await upsertUserByEmail(env, 'owner@teamed.com', now);
		const teamId = (await userMemberships(env, user.id))[0]?.teamId as string;

		// The owner of a brand-new personal team holds no role on an unassigned site.
		expect(await siteRole(env, user.id, site.id)).toBeNull();

		const res = await admin(`/api/sites/${site.id}/team`, {
			method: 'PATCH',
			headers: JSON_HEADERS,
			body: JSON.stringify({ team_id: teamId }),
		});
		expect(res.status).toBe(200);
		expect(await siteRole(env, user.id, site.id)).toBe('owner');

		// And unassigning revokes every session's access to the site in one step.
		const cleared = await admin(`/api/sites/${site.id}/team`, {
			method: 'PATCH',
			headers: JSON_HEADERS,
			body: JSON.stringify({ team_id: null }),
		});
		expect(cleared.status).toBe(200);
		expect(await siteRole(env, user.id, site.id)).toBeNull();
	});

	it('refuses a team id that does not exist, rather than silently orphaning the site', async () => {
		const site = await createSite('Orphan', 'orphan.com');
		const res = await admin(`/api/sites/${site.id}/team`, {
			method: 'PATCH',
			headers: JSON_HEADERS,
			body: JSON.stringify({ team_id: 'no-such-team' }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'unknown_team' });
	});

	it('404s assigning a team to a site that does not exist', async () => {
		const res = await admin('/api/sites/00000000-0000-4000-8000-000000000000/team', {
			method: 'PATCH',
			headers: JSON_HEADERS,
			body: JSON.stringify({ team_id: null }),
		});
		expect(res.status).toBe(404);
	});

	it('rejects a missing or wrong admin token with 401 invalid_admin_token', async () => {
		const missing = await admin('/api/sites');
		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual({ error: 'invalid_admin_token' });

		const wrong = await admin('/api/sites', {
			headers: { Authorization: 'Bearer nope' },
		});
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toEqual({ error: 'invalid_admin_token' });
	});
});
