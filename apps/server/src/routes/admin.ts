// Admin endpoints for sites and API keys, all behind requireAdmin. Sites and keys are bespoke
// (sites aren't site-scoped; keys use one-time issuance and never expose their hash), so they do
// not use the generic crudRouter.

import {
	CreateSiteSchema,
	IssueKeySchema,
	SetIdentitySchema,
	SetSiteTeamSchema,
	type Site,
} from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { siteExists } from '../db/catalog.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { revokeSessions } from '../lib/accounts.js';
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
		if (!(await siteExists(c.env, siteId))) {
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

// Assign a site to a team, which is what makes every session/RBAC path reachable. Until this
// existed, `sites.team_id` was writable by nothing in the shipped code: `siteRole` therefore always
// returned null, so the dashboard-session branch of `requireSiteAccess` was dead and the whole
// accounts/RBAC surface could only be exercised by a test writing the column with raw SQL. A team id
// comes from `GET /api/auth/me`, which returns the caller's memberships. Passing `team_id: null`
// unassigns the site, which revokes every session's access to it in one step.
adminRoutes.patch(
	'/sites/:id/team',
	requireAdmin,
	vValidator('json', SetSiteTeamSchema, validationErrorHook),
	async (c) => {
		const siteId = c.req.param('id') ?? '';
		const { team_id } = c.req.valid('json');
		if (!(await siteExists(c.env, siteId))) {
			return c.json({ error: 'not_found' }, 404);
		}
		// A site pointed at a team that does not exist grants access to nobody and is silently
		// broken, so the id is checked rather than trusted.
		if (team_id) {
			const team = await db(c.env)
				.select({ id: schema.teams.id })
				.from(schema.teams)
				.where(eq(schema.teams.id, team_id))
				.get();
			if (!team) {
				return c.json({ error: 'unknown_team' }, 400);
			}
		}
		await db(c.env)
			.update(schema.sites)
			.set({ teamId: team_id ?? null })
			.where(eq(schema.sites.id, siteId));
		return c.json({ site: { id: siteId, team_id: team_id ?? null } });
	},
);

/**
 * End every session an operator holds. The lever the CRM audit log points at.
 *
 * The log names the operator whose session read the contact table; without this, the only person who
 * could act on that was the operator themselves, which is precisely the wrong person when the
 * question is whether their session was stolen. `/api/auth/logout-everywhere` is the self-service
 * form of the same call.
 *
 * Behind `ADMIN_TOKEN` rather than a team role, and that is a deliberate limit rather than an
 * oversight. Team admins have no user-management surface at all today — they cannot list their
 * members, rename them, or remove them — and a route that reaches across to another person's
 * sessions would be the first thing of its kind, arriving without any of the structure that should
 * come with it. Ending someone's sessions is a deployment-operator action until that exists.
 *
 * Idempotent: revoking twice is two epochs and the same outcome. `404` distinguishes "no such user"
 * from "done", so a typo'd id is not silently reported as a revocation that never happened.
 */
adminRoutes.post('/users/:id/revoke-sessions', requireAdmin, async (c) => {
	const userId = c.req.param('id') ?? '';
	if (!(await revokeSessions(c.env, userId))) {
		return c.json({ error: 'not_found' }, 404);
	}
	return c.json({ user_id: userId, sessions_revoked: true });
});

adminRoutes.post(
	'/keys',
	requireAdmin,
	vValidator('json', IssueKeySchema, validationErrorHook),
	async (c) => {
		const { site_id, label, scopes } = c.req.valid('json');
		if (!(await siteExists(c.env, site_id))) throw new ApiError('not_found', 404);
		const issued = await issueKey(c.env, site_id, label ?? null, Date.now(), scopes);
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
