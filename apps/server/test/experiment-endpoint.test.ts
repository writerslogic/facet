// Experiment CRUD + result endpoints: create an experiment (admin), read the public /active flag
// config (no auth), enumerate via the API-key catalog, and assert the /stats/experiment result.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const T0 = Date.parse('2026-04-01T00:00:00.000Z');
const H = 3_600_000;

async function setup(): Promise<{ siteId: string; key: string }> {
	const siteRes = await app.request(
		'/api/sites',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Acme', domain: 'acme.com' }),
		},
		env,
	);
	const { site } = (await siteRes.json()) as { site: { id: string } };
	const keyRes = await app.request(
		'/api/keys',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({ site_id: site.id }),
		},
		env,
	);
	const { key } = (await keyRes.json()) as { key: string };
	return { siteId: site.id, key };
}

async function seedEvent(
	siteId: string,
	visitor: string,
	path: string,
	name: string | null,
	props: Record<string, unknown> | null,
	at: number,
): Promise<void> {
	await db(env)
		.insert(schema.events)
		.values({
			id: crypto.randomUUID(),
			siteId,
			hostname: 'acme.com',
			path,
			referrer: '',
			name,
			props: props ? JSON.stringify(props) : null,
			visitorHash: visitor,
			country: 'US',
			device: 'desktop',
			createdAt: at,
			channel: 'organic',
		});
}

describe('experiments endpoints', () => {
	it('creates, serves /active without auth, enumerates, and reports results', async () => {
		const { siteId, key } = await setup();

		const created = await app.request(
			'/api/experiments',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({
					site_id: siteId,
					name: 'CTA',
					flag_key: 'cta',
					variants: [
						{ key: 'control', weight: 1 },
						{ key: 'blue', weight: 1 },
					],
				}),
			},
			env,
		);
		expect(created.status).toBe(201);
		const { experiment } = (await created.json()) as {
			experiment: { id: string; active: boolean; variants: unknown[] };
		};
		expect(experiment.active).toBe(true);
		expect(experiment.variants).toHaveLength(2);

		// Public flag config, no auth.
		const active = await app.request(`/api/experiments/active?site_id=${siteId}`, {}, env);
		expect(active.status).toBe(200);
		const { experiments: flags } = (await active.json()) as {
			experiments: { id: string; flag_key: string; variants: unknown[] }[];
		};
		expect(flags).toHaveLength(1);
		expect(flags[0]?.flag_key).toBe('cta');

		// Bad site_id → empty, still no auth.
		const badActive = await app.request('/api/experiments/active?site_id=nope', {}, env);
		expect(((await badActive.json()) as { experiments: unknown[] }).experiments).toEqual([]);

		// API-key catalog enumerate.
		const catalog = await app.request(
			`/api/stats/experiments?site_id=${siteId}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(catalog.status).toBe(200);
		const { experiments } = (await catalog.json()) as {
			experiments: { id: string }[];
		};
		expect(experiments[0]?.id).toBe(experiment.id);

		// Seed exposures + conversions: control 2/1, blue 2/2.
		await seedEvent(siteId, 'a', '/', '$exposure', { flag: 'cta', variant: 'control' }, T0);
		await seedEvent(siteId, 'a', '/thanks', 'signup', null, T0 + H);
		await seedEvent(siteId, 'b', '/', '$exposure', { flag: 'cta', variant: 'control' }, T0);
		await seedEvent(siteId, 'c', '/', '$exposure', { flag: 'cta', variant: 'blue' }, T0);
		await seedEvent(siteId, 'c', '/thanks', 'signup', null, T0 + H);
		await seedEvent(siteId, 'd', '/', '$exposure', { flag: 'cta', variant: 'blue' }, T0);
		await seedEvent(siteId, 'd', '/thanks', 'signup', null, T0 + H);

		const qs = `site_id=${siteId}&experiment_id=${experiment.id}&goal_type=event&goal_value=signup&start=${T0}&end=${T0 + 24 * H}`;
		const res = await app.request(
			`/api/stats/experiment?${qs}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			variants: {
				key: string;
				exposures: number;
				conversions: number;
				rate: number;
			}[];
		};
		expect(body.variants[0]).toMatchObject({
			key: 'control',
			exposures: 2,
			conversions: 1,
		});
		expect(body.variants[1]).toMatchObject({
			key: 'blue',
			exposures: 2,
			conversions: 2,
		});

		// Delete.
		const del = await app.request(
			`/api/experiments/${experiment.id}?site_id=${siteId}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del.status).toBe(200);
	});

	it('rejects a 1-variant experiment with 400', async () => {
		const { siteId } = await setup();
		const res = await app.request(
			'/api/experiments',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({
					site_id: siteId,
					name: 'bad',
					flag_key: 'x',
					variants: [{ key: 'control', weight: 1 }],
				}),
			},
			env,
		);
		expect(res.status).toBe(400);
	});
});
