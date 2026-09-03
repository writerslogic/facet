// Experiments router. Admin CRUD mirrors funnels.ts (variants serialized to JSON on insert, parsed
// on list). `status` is the durable draft/active/completed lifecycle; `active` is retained as a
// synchronized compatibility mirror. The `/active` route is intentionally unauthenticated: it
// serves client-facing flag definitions so the browser can bucket locally. No server-side identity
// is involved — the server only stores aggregate exposure/conversion events.

import { type Experiment, ExperimentSchema, type ExperimentStatus } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';
import { listActiveExperiments, listExperiments, siteExists } from '../db/catalog.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { requireAdmin } from '../lib/auth.js';
import { ApiError, validationErrorHook } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp } from '../lib/request-meta.js';

const UuidSchema = v.pipe(v.string(), v.uuid());

export const experimentsRoutes = new Hono<AppEnv>();

function validateAllocation(variants: Experiment['variants']): void {
	const keys = variants.map((variant) => variant.key);
	if (new Set(keys).size !== keys.length) {
		throw new ApiError('duplicate_variant', 400, 'Variant keys must be unique.');
	}
	if (variants.reduce((total, variant) => total + variant.weight, 0) <= 0) {
		throw new ApiError(
			'invalid_allocation',
			400,
			'At least one variant must have a positive weight.',
		);
	}
}

function assertCompatibleStatus(
	status: ExperimentStatus | undefined,
	active: boolean | undefined,
): void {
	if (status !== undefined && active !== undefined && active !== (status === 'active')) {
		throw new ApiError(
			'status_conflict',
			400,
			'Legacy active and lifecycle status fields describe different states.',
		);
	}
}

/** Preserve the old create default (active) while allowing lifecycle-aware clients to save drafts. */
function createStatus(
	status: ExperimentStatus | undefined,
	active: boolean | undefined,
): ExperimentStatus {
	assertCompatibleStatus(status, active);
	const next = status ?? (active === false ? 'draft' : 'active');
	if (next === 'completed') {
		throw new ApiError(
			'invalid_lifecycle',
			400,
			'An experiment must be created as a draft or active run.',
		);
	}
	return next;
}

function requestedStatus(
	current: ExperimentStatus,
	status: ExperimentStatus | undefined,
	active: boolean | undefined,
): ExperimentStatus {
	assertCompatibleStatus(status, active);
	if (status !== undefined) return status;
	if (active === undefined) return current;
	if (active) return 'active';
	return current === 'draft' ? 'draft' : 'completed';
}

function validateTransition(
	current: ExperimentStatus,
	next: ExperimentStatus,
	configChanged: boolean,
): void {
	if (current === 'active' && configChanged) {
		throw new ApiError(
			'allocation_locked',
			409,
			'Running experiment allocation cannot be edited. Complete it before changing config.',
		);
	}
	if (current === 'active' && next === 'draft') {
		throw new ApiError('invalid_lifecycle', 409, 'An active experiment can only be completed.');
	}
	if (current === 'draft' && next === 'completed') {
		throw new ApiError(
			'invalid_lifecycle',
			409,
			'A draft must be started before it can complete.',
		);
	}
	if (current === 'completed' && (next !== 'completed' || configChanged)) {
		throw new ApiError(
			'lifecycle_locked',
			409,
			'Completed experiments are immutable. Create a new draft to run another allocation.',
		);
	}
}

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
		validateAllocation(body.variants);
		const status = createStatus(body.status, body.active);
		// experiments.site_id carries no foreign key, so an unchecked insert orphans a row that
		// only ever surfaces as an experiment no site can read.
		if (!(await siteExists(c.env, body.site_id))) {
			return c.json({ error: 'not_found' }, 404);
		}
		const experiment: Experiment = {
			created_at: Date.now(),
			id: crypto.randomUUID(),
			site_id: body.site_id,
			name: body.name,
			flag_key: body.flag_key,
			variants: body.variants,
			status,
			active: status === 'active',
			started_at: null,
			completed_at: null,
		};
		if (experiment.status === 'active') experiment.started_at = experiment.created_at;
		await db(c.env)
			.insert(schema.experiments)
			.values({
				id: experiment.id,
				site_id: experiment.site_id,
				name: experiment.name,
				flag_key: experiment.flag_key,
				variants: JSON.stringify(experiment.variants),
				status: experiment.status,
				active: experiment.active ? 1 : 0,
				started_at: experiment.started_at,
				completed_at: experiment.completed_at,
				created_at: experiment.created_at,
			});
		return c.json({ experiment }, 201);
	},
);

experimentsRoutes.get('/', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	return c.json({ experiments: await listExperiments(c.env, siteId) });
});

experimentsRoutes.patch(
	'/:id',
	requireAdmin,
	vValidator('json', ExperimentSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		validateAllocation(body.variants);
		const id = c.req.param('id');
		if (!id) throw new ApiError('not_found', 404);
		const row = await db(c.env)
			.select()
			.from(schema.experiments)
			.where(and(eq(schema.experiments.id, id), eq(schema.experiments.site_id, body.site_id)))
			.get();
		if (!row) return c.json({ error: 'not_found' }, 404);

		const nextStatus = requestedStatus(row.status, body.status, body.active);
		const configChanged =
			body.name !== row.name ||
			body.flag_key !== row.flag_key ||
			JSON.stringify(body.variants) !== row.variants;
		validateTransition(row.status, nextStatus, configChanged);
		const transitionedAt = Date.now();
		const startedAt =
			row.status === 'draft' && nextStatus === 'active' ? transitionedAt : row.started_at;
		const completedAt =
			row.status === 'active' && nextStatus === 'completed'
				? transitionedAt
				: row.completed_at;

		await db(c.env)
			.update(schema.experiments)
			.set({
				name: body.name,
				flag_key: body.flag_key,
				variants: JSON.stringify(body.variants),
				status: nextStatus,
				active: nextStatus === 'active' ? 1 : 0,
				started_at: startedAt,
				completed_at: completedAt,
			})
			.where(eq(schema.experiments.id, row.id));

		const experiment: Experiment = {
			id: row.id,
			site_id: row.site_id,
			name: body.name,
			flag_key: body.flag_key,
			variants: body.variants,
			status: nextStatus,
			active: nextStatus === 'active',
			started_at: startedAt,
			completed_at: completedAt,
			created_at: row.created_at,
		};
		return c.json({ experiment });
	},
);

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
