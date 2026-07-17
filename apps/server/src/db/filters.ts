// Canonical WHERE-builder for the `events` table. Every stats helper composes `buildEventWhere`
// for the site/hostname/time predicate so no helper hand-writes its own WHERE (see the DRY mandate;
// extended in T082 with path/country/device/channel filters).

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
