// Persistent chart annotations. Reads follow the analytics authorization contract (a read-scoped
// site key or an operator session for that site); writes require the deployment ADMIN_TOKEN. Keeping
// those two capabilities separate means a dashboard key can display context without becoming a
// configuration credential.

import {
	StatsQuerySchema,
	type TimelineAnnotation,
	type TimelineAnnotationCategory,
	TimelineAnnotationSchema,
} from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { requireAdmin, requireSiteAccess } from '../lib/auth.js';
import { DAY_MS, MAX_RANGE_DAYS } from '../lib/constants.js';
import { ApiError, validationErrorHook } from '../lib/http.js';

export const annotationsRoutes = new Hono<AppEnv>();

function toPublic(row: typeof schema.timelineAnnotations.$inferSelect): TimelineAnnotation {
	return {
		id: row.id,
		site_id: row.site_id,
		label: row.label,
		category: row.category as TimelineAnnotationCategory,
		occurred_at: row.occurred_at,
		created_at: row.created_at,
	};
}

annotationsRoutes.get(
	'/',
	requireSiteAccess,
	vValidator('query', StatsQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		if (query.site_id !== c.get('siteId')) throw new ApiError('site_mismatch', 403);
		if (query.end <= query.start) throw new ApiError('bad_range', 400);
		if (query.end - query.start > MAX_RANGE_DAYS * DAY_MS) {
			throw new ApiError('range_too_large', 400);
		}
		const rows = await db(c.env)
			.select()
			.from(schema.timelineAnnotations)
			.where(
				and(
					eq(schema.timelineAnnotations.site_id, query.site_id),
					gte(schema.timelineAnnotations.occurred_at, query.start),
					lt(schema.timelineAnnotations.occurred_at, query.end),
				),
			)
			.orderBy(asc(schema.timelineAnnotations.occurred_at));
		return c.json({ annotations: rows.map(toPublic) });
	},
);

annotationsRoutes.post(
	'/',
	requireAdmin,
	vValidator('json', TimelineAnnotationSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		const row = {
			id: crypto.randomUUID(),
			site_id: body.site_id,
			label: body.label,
			category: body.category ?? 'note',
			occurred_at: body.occurred_at,
			created_at: Date.now(),
		};
		await db(c.env).insert(schema.timelineAnnotations).values(row);
		return c.json({ annotation: toPublic(row) }, 201);
	},
);

annotationsRoutes.delete('/:id', requireAdmin, async (c) => {
	const siteId = c.req.query('site_id') ?? '';
	const deleted = await db(c.env)
		.delete(schema.timelineAnnotations)
		.where(
			and(
				eq(schema.timelineAnnotations.id, c.req.param('id')),
				eq(schema.timelineAnnotations.site_id, siteId),
			),
		)
		.returning({ id: schema.timelineAnnotations.id });
	if (deleted.length === 0) return c.json({ error: 'not_found' }, 404);
	return c.json({ deleted: true });
});
