// Admin CRUD for site-scoped conversion goals, via the crudRouter factory.

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
