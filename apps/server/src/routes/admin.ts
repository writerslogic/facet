// Admin endpoints for sites and API keys, all behind requireAdmin. Sites and keys are bespoke
// (sites aren't site-scoped; keys use one-time issuance and never expose their hash), so they do
// not use the generic crudRouter.

import { CreateSiteSchema, IssueKeySchema, SetIdentitySchema, type Site } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { issueKey, listKeys, revokeKey } from '../lib/apikeys.js';
import { requireAdmin } from '../lib/auth.js';
import { ApiError, validationErrorHook } from '../lib/http.js';
import { getSigningKey } from '../lib/signing.js';

export const adminRoutes = new Hono<AppEnv>();

// requireAdmin is applied per-route (not via a `use('*')`): these routers share the `/api` base
// with the public collect/health/stats routes, so a catch-all guard would hijack unknown `/api`
// paths and turn their 404 into a 401.

adminRoutes.post(
	'/sites',
	requireAdmin,
	vValidator('json', CreateSiteSchema, validationErrorHook),
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

// Set a site's identity tier + salt window. Its own requireAdmin (the router has no catch-all guard).
// The site must exist, so a config row can't be orphaned onto a reused id. Any tier above `anonymous`
// needs a deployment signing key (consent must be signable) — 501 rather than a silent clamp so the
// operator sees why elevation didn't take. `anonymous` always forces the `day` window (Tier 0).
adminRoutes.patch(
	'/sites/:id/identity',
	requireAdmin,
	vValidator('json', SetIdentitySchema, validationErrorHook),
	async (c) => {
		const siteId = c.req.param('id') ?? '';
		const body = c.req.valid('json');
		const site = await db(c.env)
			.select({ id: schema.sites.id })
			.from(schema.sites)
			.where(eq(schema.sites.id, siteId))
			.get();
		if (!site) {
			return c.json({ error: 'not_found' }, 404);
		}
		if (body.tier !== 'anonymous' && getSigningKey(c.env) === null) {
			return c.json({ error: 'identity_signing_unconfigured' }, 501);
		}
		const saltWindow = body.tier === 'anonymous' ? 'day' : body.salt_window;
		const now = Date.now();
		await db(c.env)
			.insert(schema.siteConfig)
			.values({
				site_id: siteId,
				tier: body.tier,
				salt_window: saltWindow,
				updated_at: now,
			})
			.onConflictDoUpdate({
				target: schema.siteConfig.site_id,
				set: {
					tier: body.tier,
					salt_window: saltWindow,
					updated_at: now,
				},
			});
		return c.json({
			identity: {
				site_id: siteId,
				tier: body.tier,
				salt_window: saltWindow,
			},
		});
	},
);

adminRoutes.post(
	'/keys',
	requireAdmin,
	vValidator('json', IssueKeySchema, validationErrorHook),
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
