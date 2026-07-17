// T058 + T059: funnels. CRUD mirrors crudRouter but serializes `steps` to JSON on insert and parses
// it back on list (the TEXT `steps` column can't take the validated array verbatim, so the generic
// factory doesn't fit); create/list/delete otherwise follow the same admin contract. The report
// endpoint is API-key authed and reuses funnelReport.

import { type Funnel, FunnelSchema, type FunnelStep } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { funnelReport } from '../db/funnels.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { requireAdmin, requireApiKey } from '../lib/auth.js';
import { DAY_MS, MAX_RANGE_DAYS } from '../lib/constants.js';
import { ApiError } from '../lib/http.js';

export const funnelsRoutes = new Hono<AppEnv>();

// requireAdmin is applied per-CRUD-route (not via `use('*')`) so it does not hijack the API-key
// authed report route that shares this router.

funnelsRoutes.post(
	'/',
	requireAdmin,
	vValidator('json', FunnelSchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const body = c.req.valid('json');
		const funnel: Funnel = {
			id: crypto.randomUUID(),
			site_id: body.site_id,
			name: body.name,
			steps: body.steps,
			created_at: Date.now(),
		};
		await db(c.env)
			.insert(schema.funnels)
			.values({
				id: funnel.id,
				site_id: funnel.site_id,
				name: funnel.name,
				steps: JSON.stringify(funnel.steps),
				created_at: funnel.created_at,
			});
		return c.json({ funnel }, 201);
	},
);

funnelsRoutes.get('/', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const rows = await db(c.env)
		.select()
		.from(schema.funnels)
		.where(eq(schema.funnels.site_id, siteId))
		.orderBy(desc(schema.funnels.created_at));
	const funnels: Funnel[] = rows.map((r) => ({
		id: r.id,
		site_id: r.site_id,
		name: r.name,
		steps: JSON.parse(r.steps) as FunnelStep[],
		created_at: r.created_at,
	}));
	return c.json({ funnels });
});

funnelsRoutes.delete('/:id', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const deleted = await db(c.env)
		.delete(schema.funnels)
		.where(and(eq(schema.funnels.id, c.req.param('id')), eq(schema.funnels.site_id, siteId)))
		.returning({ id: schema.funnels.id });
	if (deleted.length === 0) {
		return c.json({ error: 'not_found' }, 404);
	}
	return c.json({ deleted: true });
});

funnelsRoutes.get('/:id/report', requireApiKey, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	const start = Number(c.req.query('start'));
	const end = Number(c.req.query('end'));
	if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
		throw new ApiError('bad_range', 400);
	}
	if (end - start > MAX_RANGE_DAYS * DAY_MS) {
		throw new ApiError('range_too_large', 400);
	}
	const row = await db(c.env)
		.select()
		.from(schema.funnels)
		.where(and(eq(schema.funnels.id, c.req.param('id')), eq(schema.funnels.site_id, siteId)))
		.get();
	if (!row) {
		return c.json({ error: 'not_found' }, 404);
	}
	const funnel: Funnel = {
		id: row.id,
		site_id: row.site_id,
		name: row.name,
		steps: JSON.parse(row.steps) as FunnelStep[],
		created_at: row.created_at,
	};
	const report = await funnelReport(c.env, funnel, {
		siteId,
		start,
		end,
	});
	return c.json(report);
});
