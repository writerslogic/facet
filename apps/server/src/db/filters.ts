// Canonical WHERE-builder for the `events` table: shared site/hostname/time predicate.

import type { StatsFilter } from '@facet/shared';
import { type SQL, and, eq, gte, lt } from 'drizzle-orm';
import * as schema from './schema.js';

/** Build the site + optional-hostname + [start, end) time predicate over `events`. */
export function buildEventWhere(f: StatsFilter): SQL {
	const conditions: SQL[] = [
		eq(schema.events.siteId, f.siteId),
		gte(schema.events.createdAt, f.start),
		lt(schema.events.createdAt, f.end),
	];
	if (f.hostname) {
		conditions.push(eq(schema.events.hostname, f.hostname));
	}
	return and(...conditions) as SQL;
}
