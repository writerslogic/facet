// Feature-flags router. Three audiences, three trust levels:
//   • GET  /active — PUBLIC, cacheable. Ships only the non-sensitive bucketing config (no targeting
//     rules) so a browser can bucket base rollout offline. ETag keys on the flags' versions, so a
//     kill-switch (which bumps version) invalidates any cached copy.
//   • POST /eval   — PUBLIC, rate-limited by IP (mirrors /collect). Applies the FULL server-side
//     ruleset via the ONE shared evaluator and returns assignments only; rules never leave the edge.
//     Honors GPC (returns defaults, non-participating) and treats `ctx.custom` as untrusted (bounded
//     by the schema). No identity is stored — the caller supplies a stable id (the SDK's `facet.exp`).
//   • CRUD         — admin-only (requireAdmin), every mutation scoped by (id, site_id). `salt` is
//     minted once at create and never changes; `version` bumps on every write.

import {
	type FlagConfig,
	type FlagContext,
	FlagEvalSchema,
	type FlagInput,
	FlagSchema,
	evaluateFlag,
} from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';
import { getEvalFlags, listActiveFlags, listFlags } from '../db/catalog.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { requireAdmin } from '../lib/auth.js';
import { isGpcOptOut } from '../lib/gpc.js';
import { validationErrorHook } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp, country, device } from '../lib/request-meta.js';

const UuidSchema = v.pipe(v.string(), v.uuid());

export const flagsRoutes = new Hono<AppEnv>();

/** Cross-field invariants valibot can't express: variant weights sum to 10000, the default is a real
 * variant, and every rule serves only declared variants (with rollout weights that also sum to 10000).
 * Returns an error code, or null when the flag is internally consistent. */
function validateFlagShape(f: FlagInput): string | null {
	const keys = new Set(f.variants.map((x) => x.key));
	if (keys.size !== f.variants.length) return 'duplicate_variant_key';
	const sum = f.variants.reduce((a, x) => a + x.weight, 0);
	if (sum !== 10000) return 'variant_weights_must_sum_to_10000';
	if (!keys.has(f.default_variant)) return 'default_variant_not_in_variants';
	for (const rule of f.rules ?? []) {
		if ('variant' in rule.serve) {
			if (!keys.has(rule.serve.variant)) return 'rule_serves_unknown_variant';
		} else {
			const rolloutSum = rule.serve.rollout.reduce((a, x) => a + x.weight, 0);
			if (rolloutSum !== 10000) return 'rule_rollout_weights_must_sum_to_10000';
			for (const x of rule.serve.rollout) {
				if (!keys.has(x.key)) return 'rule_serves_unknown_variant';
			}
		}
	}
	return null;
}

/** Weak ETag over the site's flag versions: changes whenever any flag is created, edited, toggled, or
 * deleted, so the public cache turns over on a kill-switch without shipping per-request timestamps. */
function activeEtag(flags: { version: number }[]): string {
	const sum = flags.reduce((a, x) => a + x.version, 0);
	return `W/"flags-${flags.length}-${sum}"`;
}

// --- Public: cacheable bucketing config (non-sensitive; no targeting rules) --------------------------
// Registered before the admin routes so requireAdmin never shadows it.
flagsRoutes.get('/active', async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	if (!v.safeParse(UuidSchema, siteId).success) {
		return c.json({ flags: [] });
	}
	const flags = await listActiveFlags(c.env, siteId);
	const etag = activeEtag(flags);
	c.header('Cache-Control', 'public, max-age=60');
	c.header('ETag', etag);
	if (c.req.header('If-None-Match') === etag) {
		return c.body(null, 304);
	}
	return c.json({ flags });
});

// --- Public: server-side evaluation (rate-limited, GPC-aware, rules stay server-side) ---------------
flagsRoutes.post(
	'/eval',
	rateLimit((c) => `flag-eval:${clientIp(c.req.raw)}`),
	vValidator('json', FlagEvalSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		const configs = await getEvalFlags(c.env, body.site_id, body.keys);
		// GPC opt-out: serve every requested flag its default, non-participating — no bucketing at all.
		if (isGpcOptOut(c.req.raw) || body.gpc === true) {
			const flags = Object.fromEntries(
				configs.map((f: FlagConfig) => [
					f.flag_key,
					{
						variant: f.default_variant,
						participating: false,
						reason: 'gpc',
					},
				]),
			);
			return c.json({ flags });
		}
		// The SDK always supplies a stable id (facet.exp); a keyless caller gets a non-sticky draw.
		const stableId = body.id ?? crypto.randomUUID();
		// Server-derived country/device are authoritative (a browser can't know geo and could spoof it),
		// so they overlay the client-supplied ctx; only set when present, to not clobber with undefined.
		const ctx: FlagContext = { ...(body.ctx ?? {}) };
		const co = country(c.req.raw);
		if (co) ctx.country = co;
		ctx.device = device(c.req.header('user-agent') ?? '');
		const entries = await Promise.all(
			configs.map(async (f: FlagConfig) => [
				f.flag_key,
				await evaluateFlag(f, ctx, stableId),
			]),
		);
		return c.json({ flags: Object.fromEntries(entries) });
	},
);

// --- Admin CRUD (requireAdmin; every mutation scoped by (id, site_id)) ------------------------------
flagsRoutes.post(
	'/',
	requireAdmin,
	vValidator('json', FlagSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		const shapeError = validateFlagShape(body);
		if (shapeError) {
			return c.json({ error: shapeError }, 400);
		}
		const now = Date.now();
		const id = crypto.randomUUID();
		// `salt` is minted once here and never rotated: rotating it would rebucket every visitor.
		const salt = crypto.randomUUID().replace(/-/g, '');
		try {
			await db(c.env)
				.insert(schema.flags)
				.values({
					id,
					site_id: body.site_id,
					flag_key: body.flag_key,
					name: body.name,
					type: body.type,
					enabled: body.enabled === false ? 0 : 1,
					default_variant: body.default_variant,
					variants: JSON.stringify(body.variants),
					rules: JSON.stringify(body.rules ?? []),
					salt,
					rollout_seed: 0,
					version: 1,
					created_at: now,
					updated_at: now,
				});
		} catch {
			// The only constraint that can fail is the (site_id, flag_key) uniqueness index.
			return c.json({ error: 'flag_key_already_exists' }, 409);
		}
		return c.json({ flag: { id, ...body, salt, version: 1 } }, 201);
	},
);

flagsRoutes.get('/', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	if (!v.safeParse(UuidSchema, siteId).success) {
		return c.json({ flags: [] });
	}
	return c.json({ flags: await listFlags(c.env, siteId) });
});

flagsRoutes.patch(
	'/:id',
	requireAdmin,
	vValidator('json', FlagSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		const shapeError = validateFlagShape(body);
		if (shapeError) {
			return c.json({ error: shapeError }, 400);
		}
		// salt is intentionally NOT updated; version increments so /active caches invalidate.
		const updated = await db(c.env)
			.update(schema.flags)
			.set({
				flag_key: body.flag_key,
				name: body.name,
				type: body.type,
				enabled: body.enabled === false ? 0 : 1,
				default_variant: body.default_variant,
				variants: JSON.stringify(body.variants),
				rules: JSON.stringify(body.rules ?? []),
				version: sql`${schema.flags.version} + 1`,
				updated_at: Date.now(),
			})
			.where(
				and(
					eq(schema.flags.id, c.req.param('id') ?? ''),
					eq(schema.flags.site_id, body.site_id),
				),
			)
			.returning({ id: schema.flags.id, version: schema.flags.version });
		if (updated.length === 0) {
			return c.json({ error: 'not_found' }, 404);
		}
		return c.json({
			flag: { id: updated[0]?.id, ...body, version: updated[0]?.version },
		});
	},
);

flagsRoutes.delete('/:id', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const deleted = await db(c.env)
		.delete(schema.flags)
		.where(and(eq(schema.flags.id, c.req.param('id') ?? ''), eq(schema.flags.site_id, siteId)))
		.returning({ id: schema.flags.id });
	if (deleted.length === 0) {
		return c.json({ error: 'not_found' }, 404);
	}
	return c.json({ deleted: true });
});
