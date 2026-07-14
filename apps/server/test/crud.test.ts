// T020: crudRouter factory — generic insert-with-uuid / list-by-site / delete, behind requireAdmin.
// Exercised against an ephemeral `widgets` table so it stands alone from later resource migrations.

import { env } from 'cloudflare:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import * as v from 'valibot';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env.js';
import { crudRouter } from '../src/lib/crud.js';
import { ApiError, toErrorBody } from '../src/lib/http.js';

const widgets = sqliteTable('widgets', {
	id: text('id').primaryKey(),
	site_id: text('site_id').notNull(),
	name: text('name').notNull(),
	created_at: integer('created_at').notNull(),
});

const WidgetSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	name: v.pipe(v.string(), v.minLength(1)),
});

const ADMIN = 'Bearer test-admin-token';
const SITE = '11111111-1111-4111-8111-111111111111';
const JSON_HEADERS = {
	Authorization: ADMIN,
	'content-type': 'application/json',
};

function app() {
	const a = new Hono<AppEnv>();
	a.route(
		'/widgets',
		crudRouter({ table: widgets, schema: WidgetSchema, resourceKey: 'widget' }),
	);
	a.onError((err, c) =>
		err instanceof ApiError
			? c.json(toErrorBody(err), err.status)
			: c.json({ error: 'internal_error' }, 500),
	);
	return a;
}

beforeEach(async () => {
	await env.DB.exec(
		'CREATE TABLE IF NOT EXISTS widgets (id text PRIMARY KEY NOT NULL, site_id text NOT NULL, name text NOT NULL, created_at integer NOT NULL)',
	);
});

describe('crudRouter', () => {
	it('inserts with a generated uuid, lists by site, and deletes', async () => {
		const created = await app().request(
			'/widgets',
			{
				method: 'POST',
				headers: JSON_HEADERS,
				body: JSON.stringify({ site_id: SITE, name: 'w1' }),
			},
			env,
		);
		expect(created.status).toBe(201);
		const { widget } = (await created.json()) as {
			widget: { id: string; name: string };
		};
		expect(widget.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(widget.name).toBe('w1');

		const list = await app().request(
			`/widgets?site_id=${SITE}`,
			{ headers: { Authorization: ADMIN } },
			env,
		);
		const { widgets: rows } = (await list.json()) as {
			widgets: { id: string }[];
		};
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(widget.id);

		const del = await app().request(
			`/widgets/${widget.id}?site_id=${SITE}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del.status).toBe(200);
		expect(await del.json()).toEqual({ deleted: true });

		const del2 = await app().request(
			`/widgets/${widget.id}?site_id=${SITE}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del2.status).toBe(404);
	});

	it('requires the admin token', async () => {
		const res = await app().request('/widgets', {}, env);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'invalid_admin_token' });
	});
});
