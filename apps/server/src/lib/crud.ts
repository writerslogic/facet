// Canonical admin CRUD factory for site-scoped child resources (goals, funnels, experiments,
// sources — built ONLY via this factory, no re-implemented CRUD blocks; see the DRY mandate). Each
// produced router is guarded by requireAdmin and follows the fixed insert/list/delete contract.

import { vValidator } from '@hono/valibot-validator';
import { and, desc, eq } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import type { GenericSchema } from 'valibot';
import { db } from '../db/queries.js';
import type { AppEnv } from '../env.js';
import { requireAdmin } from './auth.js';

/** A table usable by the CRUD factory: keyed by `id`, scoped by `site_id`, ordered by `created_at`. */
type CrudTable = SQLiteTable & {
	id: SQLiteColumn;
	site_id: SQLiteColumn;
	created_at: SQLiteColumn;
};

/** Build an admin CRUD router: POST (insert-with-uuid) / GET ?site_id= / DELETE /:id?site_id=. */
export function crudRouter(opts: {
	table: CrudTable;
	schema: GenericSchema;
	resourceKey: string;
}): Hono<AppEnv> {
	const { table, schema, resourceKey } = opts;
	const router = new Hono<AppEnv>();
	router.use('*', requireAdmin);

	router.post(
		'/',
		vValidator('json', schema, (result, c) => {
			if (!result.success) {
				return c.json({ error: 'validation_failed', issues: result.issues }, 400);
			}
		}),
		async (c) => {
			const body = c.req.valid('json') as Record<string, unknown>;
			const row = { id: crypto.randomUUID(), created_at: Date.now(), ...body };
			await db(c.env)
				.insert(table)
				.values(row as never);
			return c.json({ [resourceKey]: row }, 201);
		},
	);

	router.get('/', async (c) => {
		const siteId = c.req.query('site_id') ?? '';
		const rows = await db(c.env)
			.select()
			.from(table)
			.where(eq(table.site_id, siteId))
			.orderBy(desc(table.created_at));
		return c.json({ [`${resourceKey}s`]: rows });
	});

	router.delete('/:id', async (c) => {
		const siteId = c.req.query('site_id') ?? '';
		const deleted = await db(c.env)
			.delete(table)
			.where(and(eq(table.id, c.req.param('id')), eq(table.site_id, siteId)))
			.returning({ id: table.id });
		if (deleted.length === 0) {
			return c.json({ error: 'not_found' }, 404);
		}
		return c.json({ deleted: true });
	});

	return router;
}
