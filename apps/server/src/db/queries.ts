// Typed D1 access via Drizzle. `db(env)` builds a schema-bound Drizzle client; all query helpers
// (insert event, read aggregates) hang off it so table/column types stay inferred. Real queries
// land per-feature (T010/T019).

import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../env.js';
import * as schema from './schema.js';

/** Build a schema-bound Drizzle client over the D1 binding. */
export function db(env: Env) {
	return drizzle(env.DB, { schema });
}

/** Insert a raw event row. Returns the generated event id. */
export async function insertEvent(_env: Env, _row: unknown): Promise<string> {
	return '';
}
