// Funnels: admin CRUD (steps serialized to/from JSON) plus an API-key-authed report endpoint.

import { type Funnel, FunnelSchema, type FunnelStep } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { listFunnels } from '../db/catalog.js';
import { funnelReport } from '../db/funnels.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { requireAdmin, requireSiteAccess } from '../lib/auth.js';
import { DAY_MS, MAX_RANGE_DAYS } from '../lib/constants.js';
import { ApiError, validationErrorHook } from '../lib/http.js';

export const funnelsRoutes = new Hono<AppEnv>();

// requireAdmin is applied per-CRUD-route (not via `use('*')`) so it does not hijack the API-key
// authed report route that shares this router.

funnelsRoutes.post(
	'/',
	requireAdmin,
	vValidator('json', FunnelSchema, validationErrorHook),
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
	return c.json({ funnels: await listFunnels(c.env, c.req.query('site_id') ?? '') });
});

// Full replacement keeps editing deterministic: the ordered step array is validated as one unit,
// then written in one D1 statement. The site id is part of both validation and the WHERE clause, so
// an admin editing one site's list cannot accidentally move or overwrite another site's funnel.
funnelsRoutes.patch(
	'/:id',
	requireAdmin,
	vValidator('json', FunnelSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		const id = c.req.param('id');
		if (!id) throw new ApiError('not_found', 404);
		const updated = await db(c.env)
			.update(schema.funnels)
			.set({ name: body.name, steps: JSON.stringify(body.steps) })
			.where(and(eq(schema.funnels.id, id), eq(schema.funnels.site_id, body.site_id)))
			.returning({ created_at: schema.funnels.created_at });
		const row = updated[0];
		if (!row) return c.json({ error: 'not_found' }, 404);
		const funnel: Funnel = {
			id,
			site_id: body.site_id,
			name: body.name,
			steps: body.steps,
			created_at: row.created_at,
		};
		return c.json({ funnel });
	},
);

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

funnelsRoutes.get('/:id/report', requireSiteAccess, async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) {
		throw new ApiError('site_mismatch', 403);
	}
	const start = Number(c.req.query('start'));
	const end = Number(c.req.query('end'));
	// REQUIRED: safe-integer + non-negative matches StatsQuerySchema's start/end contract. Plain
	// Number.isInteger admits 1e21, which binds into D1 past int64 and 500s instead of 400ing.
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
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
