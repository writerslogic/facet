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
import { Hono } from 'hono';
import * as v from 'valibot';
import { insertSite, listSites, setSiteTeam, teamExists, upsertSiteConfig } from '../db/admin.js';
import { listBotRulesets } from '../db/bots.js';
import { siteExists } from '../db/catalog.js';
import type { AppEnv } from '../env.js';
import { revokeSessions } from '../lib/accounts.js';
import { issueKey, listKeys, revokeKey } from '../lib/apikeys.js';
import { requireAdmin } from '../lib/auth.js';
import { BotRulesetConfigError, refreshBotRulesets } from '../lib/bots-refresh.js';
import { botPatternCount, ensureBotPatterns } from '../lib/bots.js';
import { ApiError, validationErrorHook } from '../lib/http.js';
import { getSigningKey } from '../lib/signing.js';

// REQUIRED: `site_id` arrives in the query on these two, so it needs the same boundary validation
// `IssueKeySchema` already gives the POST; a presence check alone admitted any string of any length.
const SiteIdQuerySchema = v.object({ site_id: v.pipe(v.string(), v.uuid()) });

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
		await insertSite(c.env, site);
		return c.json({ site }, 201);
	},
);

adminRoutes.get('/sites', requireAdmin, async (c) => {
	const sites = await listSites(c.env);
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
		await upsertSiteConfig(c.env, siteId, body.tier, saltWindow, now);
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
			if (!(await teamExists(c.env, team_id))) {
				return c.json({ error: 'unknown_team' }, 400);
			}
		}
		await setSiteTeam(c.env, siteId, team_id ?? null);
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

async function botRulesetStatus(env: AppEnv['Bindings']) {
	// `active_patterns` is the only thing this endpoint can report that D1 cannot: how many stored
	// patterns actually survived the ReDoS screen and compiled. Priming first keeps it from reading 0
	// on a cold isolate.
	await ensureBotPatterns(env);
	const rows = await listBotRulesets(env);
	return {
		rulesets: rows.map((r) => ({
			source: r.source,
			pattern_count: r.patternCount,
			updated_at: r.updatedAt,
			etag: r.etag,
		})),
		active_patterns: botPatternCount(),
	};
}

// Operator-refreshable crawler list. Status is read-only; the refresh is a POST because it makes an
// outbound request and writes. Both are 501 when FACET_BOT_RULESET_URL is unset, matching the
// `identity_signing_unconfigured` precedent above: not-configured is distinct from failed.
adminRoutes.get('/bots/ruleset', requireAdmin, async (c) => {
	if (!c.env.FACET_BOT_RULESET_URL?.trim()) {
		return c.json({ error: 'bot_ruleset_unconfigured' }, 501);
	}
	return c.json(await botRulesetStatus(c.env));
});

adminRoutes.post('/bots/refresh', requireAdmin, async (c) => {
	if (!c.env.FACET_BOT_RULESET_URL?.trim()) {
		return c.json({ error: 'bot_ruleset_unconfigured' }, 501);
	}
	try {
		await refreshBotRulesets(c.env, Date.now());
	} catch (err) {
		// IMPORTANT: two codes and no detail. The upstream URL, its status and its body all stay
		// server-side; echoing them would let an admin-facing error report on an arbitrary host. The
		// split only separates "your config is wrong" from "the upstream failed".
		if (err instanceof BotRulesetConfigError) {
			throw new ApiError('bot_ruleset_misconfigured', 400);
		}
		throw new ApiError('bot_ruleset_refresh_failed', 502);
	}
	return c.json(await botRulesetStatus(c.env));
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

adminRoutes.get(
	'/keys',
	requireAdmin,
	vValidator('query', SiteIdQuerySchema, validationErrorHook),
	async (c) => {
		const keys = await listKeys(c.env, c.req.valid('query').site_id);
		return c.json({ keys });
	},
);

adminRoutes.delete(
	'/keys/:id',
	requireAdmin,
	vValidator('query', SiteIdQuerySchema, validationErrorHook),
	async (c) => {
		const keyId = c.req.param('id') ?? '';
		const deleted = await revokeKey(c.env, keyId, c.req.valid('query').site_id);
		if (!deleted) {
			return c.json({ error: 'not_found' }, 404);
		}
		return c.json({ deleted: true });
	},
);
