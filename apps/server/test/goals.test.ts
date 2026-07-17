// Goals CRUD: admin create -> list -> delete round-trip via the mounted /api/goals router.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const SITE = '22222222-2222-4222-8222-222222222222';
const JSON_HEADERS = {
	Authorization: ADMIN,
	'content-type': 'application/json',
};

describe('goals CRUD', () => {
	it('creates, lists, and deletes a goal', async () => {
		const created = await app.request(
			'/api/goals',
			{
				method: 'POST',
				headers: JSON_HEADERS,
				body: JSON.stringify({
					site_id: SITE,
					name: 'Signup',
					type: 'event',
					match_value: 'signup',
				}),
			},
			env,
		);
		expect(created.status).toBe(201);
		const { goal } = (await created.json()) as {
			goal: { id: string; name: string; type: string; match_value: string };
		};
		expect(goal.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(goal.name).toBe('Signup');
		expect(goal.type).toBe('event');
		expect(goal.match_value).toBe('signup');

		const list = await app.request(
			`/api/goals?site_id=${SITE}`,
			{ headers: { Authorization: ADMIN } },
			env,
		);
		expect(list.status).toBe(200);
		const { goals } = (await list.json()) as { goals: { id: string }[] };
		expect(goals).toHaveLength(1);
		expect(goals[0]?.id).toBe(goal.id);

		const del = await app.request(
			`/api/goals/${goal.id}?site_id=${SITE}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del.status).toBe(200);
		expect(await del.json()).toEqual({ deleted: true });

		const del2 = await app.request(
			`/api/goals/${goal.id}?site_id=${SITE}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del2.status).toBe(404);
	});

	it('rejects a non-admin caller with 401', async () => {
		const res = await app.request('/api/goals', { method: 'POST' }, env);
		expect(res.status).toBe(401);
	});
});
