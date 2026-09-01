// Experiments router. Admin CRUD mirrors funnels.ts (variants serialized to JSON on insert, parsed
// on list; `active` stored as 0/1). The `/active` route is intentionally unauthenticated: it serves
// client-facing flag definitions (flag_key + variants) so the browser can bucket locally. No
// server-side identity is involved — the server only stores aggregate exposure/conversion events.

import { type Experiment, ExperimentSchema } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';
import { listActiveExperiments, listExperiments, siteExists } from '../db/catalog.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { requireAdmin } from '../lib/auth.js';
import { validationErrorHook } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp } from '../lib/request-meta.js';

const UuidSchema = v.pipe(v.string(), v.uuid());

export const experimentsRoutes = new Hono<AppEnv>();

/** Weak ETag over the served config. experiments carry no `version` column (flags do), so the
 * validator keys on the payload itself; otherwise a create or delete would leave a cached copy
 * serving bucketing config the site no longer runs. */
async function activeEtag(payload: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
	const hex = Array.from(new Uint8Array(digest, 0, 8))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `W/"exp-${hex}"`;
}

// Public flag config for the browser client. Unauthenticated by design (config, not PII). Must be
// registered before the admin routes so it is not shadowed by requireAdmin.
// An unknown site 404s rather than returning an empty list: a misconfigured `data-site-id` is
// otherwise indistinguishable from a site that simply has no active experiments. Existence is not a
// secret — the id is embedded in the page's script tag — and the response body stays identical.
experimentsRoutes.get(
	'/active',
	rateLimit((c) => `exp-active:${clientIp(c.req.raw)}`),
	vValidator('query', v.object({ site_id: UuidSchema }), validationErrorHook),
	async (c) => {
		const { site_id: siteId } = c.req.valid('query');
		if (!(await siteExists(c.env, siteId))) {
			return c.json({ error: 'not_found' }, 404);
		}
		const payload = JSON.stringify({
			experiments: await listActiveExperiments(c.env, siteId),
		});
		const etag = await activeEtag(payload);
		c.header('Cache-Control', 'public, max-age=60');
		c.header('ETag', etag);
		if (c.req.header('If-None-Match') === etag) {
			return c.body(null, 304);
		}
		c.header('Content-Type', 'application/json; charset=UTF-8');
		return c.body(payload);
	},
);

experimentsRoutes.post(
	'/',
	requireAdmin,
	vValidator('json', ExperimentSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		// experiments.site_id carries no foreign key, so an unchecked insert orphans a row that
		// only ever surfaces as an experiment no site can read.
		if (!(await siteExists(c.env, body.site_id))) {
			return c.json({ error: 'not_found' }, 404);
		}
		const experiment: Experiment = {
			id: crypto.randomUUID(),
			site_id: body.site_id,
			name: body.name,
			flag_key: body.flag_key,
			variants: body.variants,
			active: body.active ?? true,
			created_at: Date.now(),
		};
		await db(c.env)
			.insert(schema.experiments)
			.values({
				id: experiment.id,
				site_id: experiment.site_id,
				name: experiment.name,
				flag_key: experiment.flag_key,
				variants: JSON.stringify(experiment.variants),
				active: experiment.active ? 1 : 0,
				created_at: experiment.created_at,
			});
		return c.json({ experiment }, 201);
	},
);

experimentsRoutes.get('/', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	return c.json({ experiments: await listExperiments(c.env, siteId) });
});

experimentsRoutes.delete('/:id', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const deleted = await db(c.env)
		.delete(schema.experiments)
		.where(
			and(
				eq(schema.experiments.id, c.req.param('id')),
				eq(schema.experiments.site_id, siteId),
			),
		)
		.returning({ id: schema.experiments.id });
	if (deleted.length === 0) {
		return c.json({ error: 'not_found' }, 404);
	}
	return c.json({ deleted: true });
});
