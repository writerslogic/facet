// Experiment CRUD + result endpoints: create an experiment (admin), read the public /active flag
// config (no auth), enumerate via the API-key catalog, and assert the /stats/experiment result.

import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
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
			headers: {
				Authorization: ADMIN,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ name: 'Acme', domain: 'acme.com' }),
		},
		env,
	);
	const { site } = (await siteRes.json()) as { site: { id: string } };
	const keyRes = await app.request(
		'/api/keys',
		{
			method: 'POST',
			headers: {
				Authorization: ADMIN,
				'content-type': 'application/json',
			},
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
				headers: {
					Authorization: ADMIN,
					'content-type': 'application/json',
				},
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
			experiment: {
				id: string;
				status: string;
				active: boolean;
				started_at: number | null;
				variants: unknown[];
			};
		};
		expect(experiment.status).toBe('active');
		expect(experiment.active).toBe(true);
		expect(experiment.started_at).not.toBeNull();
		expect(experiment.variants).toHaveLength(2);

		// Public flag config, no auth.
		const active = await app.request(`/api/experiments/active?site_id=${siteId}`, {}, env);
		expect(active.status).toBe(200);
		const { experiments: flags } = (await active.json()) as {
			experiments: {
				id: string;
				flag_key: string;
				variants: unknown[];
			}[];
		};
		expect(flags).toHaveLength(1);
		expect(flags[0]?.flag_key).toBe('cta');

		// Running allocation is immutable: silently changing keys or weights would rebucket visitors
		// while the result table still treated the run as one experiment.
		const locked = await app.request(
			`/api/experiments/${experiment.id}`,
			{
				method: 'PATCH',
				headers: {
					Authorization: ADMIN,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					site_id: siteId,
					name: 'CTA changed',
					flag_key: 'cta',
					variants: [
						{ key: 'control', weight: 1 },
						{ key: 'blue', weight: 2 },
					],
					active: true,
				}),
			},
			env,
		);
		expect(locked.status).toBe(409);
		expect(await locked.json()).toMatchObject({ error: 'allocation_locked' });

		// Completing a run is terminal and removes it from the public bucketing config.
		const completeBody = {
			site_id: siteId,
			name: 'CTA',
			flag_key: 'cta',
			variants: [
				{ key: 'control', weight: 1 },
				{ key: 'blue', weight: 1 },
			],
			status: 'completed',
		};
		const completed = await app.request(
			`/api/experiments/${experiment.id}`,
			{
				method: 'PATCH',
				headers: {
					Authorization: ADMIN,
					'content-type': 'application/json',
				},
				body: JSON.stringify(completeBody),
			},
			env,
		);
		expect(completed.status).toBe(200);
		expect(await completed.json()).toMatchObject({
			experiment: { status: 'completed', active: false },
		});

		// A malformed site_id is rejected by query validation before any lookup.
		const malformed = await app.request('/api/experiments/active?site_id=nope', {}, env);
		expect(malformed.status).toBe(400);

		// A well-formed but unknown site 404s rather than returning an empty list: an empty list
		// cannot be told apart from a misconfigured data-site-id, which is the failure worth
		// surfacing. Still no auth — existence is not a secret.
		const unknown = await app.request(
			'/api/experiments/active?site_id=99999999-9999-4999-8999-999999999999',
			{},
			env,
		);
		expect(unknown.status).toBe(404);

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

	it('persists strict draft, active, and completed lifecycle transitions', async () => {
		const { siteId } = await setup();
		const config = {
			site_id: siteId,
			name: 'Lifecycle',
			flag_key: 'lifecycle',
			variants: [
				{ key: 'control', weight: 1 },
				{ key: 'variant', weight: 1 },
			],
		};
		const created = await app.request(
			'/api/experiments',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ ...config, status: 'draft' }),
			},
			env,
		);
		const { experiment: draft } = (await created.json()) as {
			experiment: { id: string; status: string; active: boolean; started_at: number | null };
		};
		expect(draft).toMatchObject({ status: 'draft', active: false, started_at: null });

		const edited = await app.request(
			`/api/experiments/${draft.id}`,
			{
				method: 'PATCH',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ ...config, name: 'Lifecycle v2', status: 'draft' }),
			},
			env,
		);
		expect(edited.status).toBe(200);
		expect(await edited.json()).toMatchObject({
			experiment: { name: 'Lifecycle v2', status: 'draft' },
		});

		const started = await app.request(
			`/api/experiments/${draft.id}`,
			{
				method: 'PATCH',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ ...config, name: 'Lifecycle v2', status: 'active' }),
			},
			env,
		);
		expect(started.status).toBe(200);
		expect(await started.json()).toMatchObject({
			experiment: { status: 'active', active: true, completed_at: null },
		});

		const finished = await app.request(
			`/api/experiments/${draft.id}`,
			{
				method: 'PATCH',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ ...config, name: 'Lifecycle v2', status: 'completed' }),
			},
			env,
		);
		expect(finished.status).toBe(200);
		const row = await db(env)
			.select()
			.from(schema.experiments)
			.where(eq(schema.experiments.id, draft.id))
			.get();
		expect(row).toMatchObject({ status: 'completed', active: 0 });
		expect(row?.started_at).toEqual(expect.any(Number));
		expect(row?.completed_at).toEqual(expect.any(Number));
		const publicConfig = await app.request(
			`/api/experiments/active?site_id=${siteId}`,
			{},
			env,
		);
		expect(await publicConfig.json()).toMatchObject({ experiments: [] });

		const restart = await app.request(
			`/api/experiments/${draft.id}`,
			{
				method: 'PATCH',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ ...config, name: 'Lifecycle v2', status: 'active' }),
			},
			env,
		);
		expect(restart.status).toBe(409);
		expect(await restart.json()).toMatchObject({ error: 'lifecycle_locked' });
	});

	it('rejects a 1-variant experiment with 400', async () => {
		const { siteId } = await setup();
		const res = await app.request(
			'/api/experiments',
			{
				method: 'POST',
				headers: {
					Authorization: ADMIN,
					'content-type': 'application/json',
				},
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

	it('rejects duplicate keys and an all-zero allocation', async () => {
		const { siteId } = await setup();
		for (const variants of [
			[
				{ key: 'same', weight: 1 },
				{ key: 'same', weight: 1 },
			],
			[
				{ key: 'control', weight: 0 },
				{ key: 'blue', weight: 0 },
			],
		]) {
			const response = await app.request(
				'/api/experiments',
				{
					method: 'POST',
					headers: {
						Authorization: ADMIN,
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						site_id: siteId,
						name: 'bad allocation',
						flag_key: 'bad',
						variants,
					}),
				},
				env,
			);
			expect(response.status).toBe(400);
		}
	});
});
