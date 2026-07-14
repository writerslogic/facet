// Admin endpoints for sites and API keys, all behind requireAdmin. Sites and keys are bespoke
// (sites aren't site-scoped; keys use one-time issuance and never expose their hash), so they do
// not use the generic crudRouter — that factory is for the site-scoped child resources in later
// phases (goals, funnels, experiments, sources).

import { CreateSiteSchema, IssueKeySchema, type Site } from '@countless/shared';
import { vValidator } from '@hono/valibot-validator';
import { desc } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { issueKey, listKeys, revokeKey } from '../lib/apikeys.js';
import { requireAdmin } from '../lib/auth.js';
import { ApiError } from '../lib/http.js';

export const adminRoutes = new Hono<AppEnv>();

// requireAdmin is applied per-route (not via a `use('*')`): these routers share the `/api` base
// with the public collect/health/stats routes, so a catch-all guard would hijack unknown `/api`
// paths and turn their 404 into a 401.

adminRoutes.post(
	'/sites',
	requireAdmin,
	vValidator('json', CreateSiteSchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const { name, domain } = c.req.valid('json');
		const site: Site = {
			id: crypto.randomUUID(),
			name,
			domain,
			created_at: Date.now(),
		};
		await db(c.env).insert(schema.sites).values({
			id: site.id,
			name: site.name,
			domain: site.domain,
			createdAt: site.created_at,
		});
		return c.json({ site }, 201);
	},
);

adminRoutes.get('/sites', requireAdmin, async (c) => {
	const sites = await db(c.env)
		.select({
			id: schema.sites.id,
			name: schema.sites.name,
			domain: schema.sites.domain,
			created_at: schema.sites.createdAt,
		})
		.from(schema.sites)
		.orderBy(desc(schema.sites.createdAt));
	return c.json({ sites });
});

adminRoutes.post(
	'/keys',
	requireAdmin,
	vValidator('json', IssueKeySchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const { site_id, label } = c.req.valid('json');
		const issued = await issueKey(c.env, site_id, label ?? null, Date.now());
		return c.json(issued, 201);
	},
);

adminRoutes.get('/keys', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id');
	if (!siteId) {
		throw new ApiError('bad_request', 400, 'site_id query parameter is required');
	}
	const keys = await listKeys(c.env, siteId);
	return c.json({ keys });
});

adminRoutes.delete('/keys/:id', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id');
	if (!siteId) {
		throw new ApiError('bad_request', 400, 'site_id query parameter is required');
	}
	const deleted = await revokeKey(c.env, c.req.param('id'), siteId);
	if (!deleted) {
		return c.json({ error: 'not_found' }, 404);
	}
	return c.json({ deleted: true });
});
