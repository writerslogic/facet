// Admin sites & keys endpoints: create/list sites, issue/list(no hash)/revoke keys, behind requireAdmin.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

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
