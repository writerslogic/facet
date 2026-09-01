// Timeline annotation contract: admin-only writes, site-key reads over a bounded window, strict
// site isolation, and site-scoped deletion. Runs against the real D1 binding and migrations.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const DAY = 86_400_000;

async function setup(): Promise<{ siteId: string; key: string }> {
	const siteRes = await app.request(
		'/api/sites',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Acme', domain: 'acme.example' }),
		},
		env,
	);
	const { site } = (await siteRes.json()) as { site: { id: string } };
	const keyRes = await app.request(
		'/api/keys',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({ site_id: site.id, scopes: ['read'] }),
		},
		env,
	);
	const { key } = (await keyRes.json()) as { key: string };
	return { siteId: site.id, key };
}

async function create(
	siteId: string,
	occurredAt: number,
	label = ' Release 2.0 ',
): Promise<string> {
	const response = await app.request(
		'/api/annotations',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({
				site_id: siteId,
				label,
				category: 'release',
				occurred_at: occurredAt,
			}),
		},
		env,
	);
	expect(response.status).toBe(201);
	const body = (await response.json()) as {
		annotation: { id: string; label: string; category: string };
	};
	expect(body.annotation.label).toBe(label.trim());
	expect(body.annotation.category).toBe('release');
	return body.annotation.id;
}

describe('/api/annotations', () => {
	it('lists only notes inside the requested range for the key-owning site', async () => {
		const { siteId, key } = await setup();
		await create(siteId, T0 - DAY, 'Before range');
		await create(siteId, T0 + DAY, 'Inside range');
		await create(siteId, T0 + 3 * DAY, 'After range');

		const response = await app.request(
			`/api/annotations?site_id=${siteId}&start=${T0}&end=${T0 + 2 * DAY}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { annotations: { label: string }[] };
		expect(body.annotations.map((annotation) => annotation.label)).toEqual(['Inside range']);
	});

	it('does not grant writes to a read key and rejects malformed notes', async () => {
		const { siteId, key } = await setup();
		const withReadKey = await app.request(
			'/api/annotations',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${key}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ site_id: siteId, label: 'No', occurred_at: T0 }),
			},
			env,
		);
		expect(withReadKey.status).toBe(401);

		const blank = await app.request(
			'/api/annotations',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ site_id: siteId, label: '   ', occurred_at: T0 }),
			},
			env,
		);
		expect(blank.status).toBe(400);
	});

	it('rejects cross-site reads and inverted ranges', async () => {
		const first = await setup();
		const second = await setup();
		const crossSite = await app.request(
			`/api/annotations?site_id=${second.siteId}&start=${T0}&end=${T0 + DAY}`,
			{ headers: { Authorization: `Bearer ${first.key}` } },
			env,
		);
		expect(crossSite.status).toBe(403);

		const inverted = await app.request(
			`/api/annotations?site_id=${first.siteId}&start=${T0 + DAY}&end=${T0}`,
			{ headers: { Authorization: `Bearer ${first.key}` } },
			env,
		);
		expect(inverted.status).toBe(400);
	});

	it('deletes by both annotation id and site id', async () => {
		const first = await setup();
		const second = await setup();
		const id = await create(first.siteId, T0, 'Incident resolved');

		const wrongSite = await app.request(
			`/api/annotations/${id}?site_id=${second.siteId}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(wrongSite.status).toBe(404);

		const deleted = await app.request(
			`/api/annotations/${id}?site_id=${first.siteId}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(deleted.status).toBe(200);
	});
});
