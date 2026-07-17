// Funnels CRUD: create -> list (steps parsed back to an array) -> delete; a 1-step funnel
// fails validation with 400 validation_failed.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const SITE = '33333333-3333-4333-8333-333333333333';
const JSON_HEADERS = {
	Authorization: ADMIN,
	'content-type': 'application/json',
};

const STEPS = [
	{ type: 'path', match_value: '/pricing' },
	{ type: 'event', match_value: 'signup' },
];

describe('funnels CRUD', () => {
	it('creates, lists with steps parsed, and deletes a funnel', async () => {
		const created = await app.request(
			'/api/funnels',
			{
				method: 'POST',
				headers: JSON_HEADERS,
				body: JSON.stringify({ site_id: SITE, name: 'Purchase', steps: STEPS }),
			},
			env,
		);
		expect(created.status).toBe(201);
		const { funnel } = (await created.json()) as {
			funnel: { id: string; steps: { type: string; match_value: string }[] };
		};
		expect(funnel.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(funnel.steps).toEqual(STEPS);

		const list = await app.request(
			`/api/funnels?site_id=${SITE}`,
			{ headers: { Authorization: ADMIN } },
			env,
		);
		expect(list.status).toBe(200);
		const { funnels } = (await list.json()) as {
			funnels: { id: string; steps: unknown }[];
		};
		expect(funnels).toHaveLength(1);
		expect(funnels[0]?.id).toBe(funnel.id);
		expect(funnels[0]?.steps).toEqual(STEPS);

		const del = await app.request(
			`/api/funnels/${funnel.id}?site_id=${SITE}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del.status).toBe(200);
		expect(await del.json()).toEqual({ deleted: true });

		const del2 = await app.request(
			`/api/funnels/${funnel.id}?site_id=${SITE}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del2.status).toBe(404);
	});

	it('rejects a 1-step funnel with 400 validation_failed', async () => {
		const res = await app.request(
			'/api/funnels',
			{
				method: 'POST',
				headers: JSON_HEADERS,
				body: JSON.stringify({
					site_id: SITE,
					name: 'Too short',
					steps: [{ type: 'path', match_value: '/only' }],
				}),
			},
			env,
		);
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: 'validation_failed',
		});
	});

	it('rejects a non-admin caller with 401', async () => {
		const res = await app.request('/api/funnels', { method: 'POST' }, env);
		expect(res.status).toBe(401);
	});
});
