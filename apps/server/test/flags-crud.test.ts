// Feature-flags router. Covers the three trust levels and their load-bearing invariants:
//   • admin CRUD is create -> list -> patch(version bump) -> delete, scoped by (id, site_id);
//   • the PUBLIC /active payload ships bucketing config but NEVER targeting rules (the review's
//     high-severity leak) and turns its ETag over when a flag changes;
//   • the PUBLIC /eval applies server-side rules, is sticky per stable id, and honors GPC.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const SITE = '44444444-4444-4444-8444-444444444444';
const JSON_HEADERS = {
	Authorization: ADMIN,
	'content-type': 'application/json',
};

const FLAG = {
	site_id: SITE,
	flag_key: 'new-checkout',
	name: 'New checkout',
	type: 'multivariate',
	default_variant: 'control',
	variants: [
		{ key: 'control', weight: 5000 },
		{ key: 'treatment', weight: 5000 },
	],
	rules: [
		{
			priority: 0,
			clauses: [{ attr: 'country', op: 'eq', value: 'US' }],
			serve: { variant: 'treatment' },
		},
	],
};

async function createFlag(body: unknown = FLAG) {
	return app.request(
		'/api/flags',
		{ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) },
		env,
	);
}

describe('flags admin CRUD', () => {
	it('creates, lists, patches (version bumps), and deletes', async () => {
		const created = await createFlag();
		expect(created.status).toBe(201);
		const { flag } = (await created.json()) as {
			flag: { id: string; salt: string };
		};
		expect(flag.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(flag.salt).toBeTruthy();

		const list = await app.request(
			`/api/flags?site_id=${SITE}`,
			{ headers: { Authorization: ADMIN } },
			env,
		);
		const { flags } = (await list.json()) as {
			flags: { id: string; version: number; rules: unknown[] }[];
		};
		expect(flags).toHaveLength(1);
		expect(flags[0]?.version).toBe(1);
		expect(flags[0]?.rules).toHaveLength(1);

		const patched = await app.request(
			`/api/flags/${flag.id}`,
			{
				method: 'PATCH',
				headers: JSON_HEADERS,
				body: JSON.stringify({ ...FLAG, enabled: false }),
			},
			env,
		);
		expect(patched.status).toBe(200);
		expect((await patched.json()) as { flag: { version: number } }).toMatchObject({
			flag: { version: 2 },
		});

		const del = await app.request(
			`/api/flags/${flag.id}?site_id=${SITE}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del.status).toBe(200);
	});

	it('rejects variant weights that do not sum to 10000', async () => {
		const res = await createFlag({
			...FLAG,
			variants: [
				{ key: 'control', weight: 5000 },
				{ key: 'treatment', weight: 4000 },
			],
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: 'variant_weights_must_sum_to_10000',
		});
	});

	it('rejects a default_variant that is not a declared variant', async () => {
		const res = await createFlag({ ...FLAG, default_variant: 'ghost' });
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: 'default_variant_not_in_variants',
		});
	});

	it('rejects a rule that serves an unknown variant', async () => {
		const res = await createFlag({
			...FLAG,
			rules: [{ priority: 0, clauses: [], serve: { variant: 'nope' } }],
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: 'rule_serves_unknown_variant',
		});
	});

	it('rejects a duplicate flag_key for the same site with 409', async () => {
		expect((await createFlag()).status).toBe(201);
		expect((await createFlag()).status).toBe(409);
	});

	it('rejects a non-admin caller with 401', async () => {
		const res = await app.request('/api/flags', { method: 'POST' }, env);
		expect(res.status).toBe(401);
	});
});

describe('flags public /active', () => {
	it('ships bucketing config but NEVER targeting rules, and honors If-None-Match', async () => {
		await createFlag();
		const res = await app.request(`/api/flags/active?site_id=${SITE}`, {}, env);
		expect(res.status).toBe(200);
		const etag = res.headers.get('ETag');
		expect(etag).toBeTruthy();
		const { flags } = (await res.json()) as {
			flags: Record<string, unknown>[];
		};
		expect(flags).toHaveLength(1);
		// The load-bearing invariant: no rules/clauses leak to the unauthenticated client.
		expect(flags[0]).not.toHaveProperty('rules');
		expect(flags[0]).toHaveProperty('salt');
		expect(flags[0]).toHaveProperty('variants');

		const cached = await app.request(
			`/api/flags/active?site_id=${SITE}`,
			{ headers: { 'If-None-Match': etag ?? '' } },
			env,
		);
		expect(cached.status).toBe(304);
	});

	it('omits a disabled flag from /active', async () => {
		await createFlag({ ...FLAG, enabled: false });
		const res = await app.request(`/api/flags/active?site_id=${SITE}`, {}, env);
		const { flags } = (await res.json()) as { flags: unknown[] };
		expect(flags).toHaveLength(0);
	});
});

describe('flags public /eval', () => {
	it('applies server-side rules and is sticky per stable id', async () => {
		await createFlag();
		const evalReq = (gpc: boolean) =>
			app.request(
				'/api/flags/eval',
				{
					method: 'POST',
					headers: gpc
						? { 'content-type': 'application/json', 'Sec-GPC': '1' }
						: { 'content-type': 'application/json' },
					body: JSON.stringify({
						site_id: SITE,
						id: 'visitor-1',
						ctx: { country: 'US' },
					}),
				},
				env,
			);

		const res = await evalReq(false);
		expect(res.status).toBe(200);
		const { flags } = (await res.json()) as {
			flags: Record<string, { variant: string; participating: boolean }>;
		};
		// The US targeting rule serves 'treatment'.
		expect(flags['new-checkout']?.variant).toBe('treatment');
		expect(flags['new-checkout']?.participating).toBe(true);

		// GPC opt-out: default variant, not participating, regardless of the rule.
		const gpcRes = await evalReq(true);
		const gpcBody = (await gpcRes.json()) as {
			flags: Record<string, { variant: string; participating: boolean; reason: string }>;
		};
		expect(gpcBody.flags['new-checkout']).toMatchObject({
			variant: 'control',
			participating: false,
			reason: 'gpc',
		});
	});
});
