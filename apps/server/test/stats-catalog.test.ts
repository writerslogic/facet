// API-key-scoped catalog endpoints: the dashboard can list a site's goals + funnels with just an
// API key (no admin token), and cross-site keys are rejected.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { issueKey } from '../src/lib/apikeys.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let key: string;

function get(path: string, apiKey: string | null) {
	return createApp().request(
		path,
		apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {},
		env,
	);
}

beforeEach(async () => {
	key = (await issueKey(env, SITE, null, Date.now())).key;
	await env.DB.prepare(
		'INSERT INTO goals (id, site_id, name, type, match_value, created_at) VALUES (?,?,?,?,?,?)',
	)
		.bind('g1', SITE, 'Signups', 'event', 'signup', Date.now())
		.run();
	await env.DB.prepare(
		'INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?,?,?,?,?)',
	)
		.bind(
			'f1',
			SITE,
			'Checkout',
			JSON.stringify([
				{ type: 'path', match_value: '/' },
				{ type: 'event', match_value: 'signup' },
			]),
			Date.now(),
		)
		.run();
});

describe('catalog endpoints', () => {
	it('lists goals for the key holder', async () => {
		const res = await get(`/api/stats/goals?site_id=${SITE}`, key);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			goals: { id: string; name: string }[];
		};
		expect(body.goals).toHaveLength(1);
		expect(body.goals[0]?.name).toBe('Signups');
	});

	it('lists funnels with steps parsed to arrays', async () => {
		const res = await get(`/api/stats/funnels?site_id=${SITE}`, key);
		const body = (await res.json()) as { funnels: { steps: unknown[] }[] };
		expect(body.funnels).toHaveLength(1);
		expect(body.funnels[0]?.steps).toHaveLength(2);
	});

	it('rejects a cross-site key with 403', async () => {
		const res = await get(`/api/stats/goals?site_id=${OTHER}`, key);
		expect(res.status).toBe(403);
	});

	it('rejects a missing key with 401', async () => {
		const res = await get(`/api/stats/goals?site_id=${SITE}`, null);
		expect(res.status).toBe(401);
	});
});
