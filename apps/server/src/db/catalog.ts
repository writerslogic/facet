// Site-scoped catalog reads for goals and funnels, shared by the admin CRUD list and the
// API-key-authenticated dashboard list endpoints (so the dashboard can enumerate a site's goals
// and funnels without the admin token). Reads only; no mutation.

import type { Funnel, FunnelStep, Goal } from '@countless/shared';
import { desc, eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { db } from './queries.js';
import * as schema from './schema.js';

/** List a site's goals, newest first. */
export async function listGoals(env: Env, siteId: string): Promise<Goal[]> {
	const rows = await db(env)
		.select()
		.from(schema.goals)
		.where(eq(schema.goals.site_id, siteId))
		.orderBy(desc(schema.goals.created_at));
	return rows.map((r) => ({
		id: r.id,
		site_id: r.site_id,
		name: r.name,
		type: r.type as Goal['type'],
		match_value: r.match_value,
		created_at: r.created_at,
	}));
}

/** List a site's funnels (steps parsed back to arrays), newest first. */
export async function listFunnels(env: Env, siteId: string): Promise<Funnel[]> {
	const rows = await db(env)
		.select()
		.from(schema.funnels)
		.where(eq(schema.funnels.site_id, siteId))
		.orderBy(desc(schema.funnels.created_at));
	return rows.map((r) => ({
		id: r.id,
		site_id: r.site_id,
		name: r.name,
		steps: JSON.parse(r.steps) as FunnelStep[],
		created_at: r.created_at,
	}));
}
