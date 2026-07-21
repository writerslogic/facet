// Experiments router. Admin CRUD mirrors funnels.ts (variants serialized to JSON on insert, parsed
// on list; `active` stored as 0/1). The `/active` route is intentionally unauthenticated: it serves
// client-facing flag definitions (flag_key + variants) so the browser can bucket locally. No
// server-side identity is involved — the server only stores aggregate exposure/conversion events.

import { type Experiment, ExperimentSchema, type ExperimentVariant } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';
import { listActiveExperiments } from '../db/catalog.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { requireAdmin } from '../lib/auth.js';
import { validationErrorHook } from '../lib/http.js';

const UuidSchema = v.pipe(v.string(), v.uuid());

export const experimentsRoutes = new Hono<AppEnv>();

// Public flag config for the browser client. Unauthenticated by design (config, not PII). Must be
// registered before the admin routes so it is not shadowed by requireAdmin.
experimentsRoutes.get('/active', async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	if (!v.safeParse(UuidSchema, siteId).success) {
		return c.json({ experiments: [] });
	}
	return c.json({ experiments: await listActiveExperiments(c.env, siteId) });
});

experimentsRoutes.post(
	'/',
	requireAdmin,
	vValidator('json', ExperimentSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
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
	const rows = await db(c.env)
		.select()
		.from(schema.experiments)
		.where(eq(schema.experiments.site_id, siteId))
		.orderBy(desc(schema.experiments.created_at));
	const experiments: Experiment[] = rows.map((r) => ({
		id: r.id,
		site_id: r.site_id,
		name: r.name,
		flag_key: r.flag_key,
		variants: JSON.parse(r.variants) as ExperimentVariant[],
		active: r.active === 1,
		created_at: r.created_at,
	}));
	return c.json({ experiments });
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
