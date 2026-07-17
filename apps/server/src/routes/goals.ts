// T055: goals CRUD — admin-only insert/list/delete of site-scoped conversion goals, built via the
// canonical crudRouter factory (no re-implemented CRUD block).

import { GoalSchema } from '@facet/shared';
import type { Hono } from 'hono';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { crudRouter } from '../lib/crud.js';

export const goalsRoutes: Hono<AppEnv> = crudRouter({
	table: schema.goals,
	schema: GoalSchema,
	resourceKey: 'goal',
});
