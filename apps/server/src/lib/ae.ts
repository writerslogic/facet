// Analytics Engine sink — the columnar analytical store on the Cloudflare scale path (U1). Every
// accepted event is mirrored here alongside its D1 row: D1 stays the authoritative metadata/config
// store and serves the bounded queries its indexes already cover, while AE absorbs the
// high-cardinality, arbitrary-dimension scans SQLite cannot.
//
// The binding is OPTIONAL. With `analytics_engine_datasets` unbound, every write here no-ops and the
// deployment behaves byte-for-byte as it did before — D1 remains the only store.
//
// Privacy is unchanged by construction: this writes the SAME already-derived columns the `events`
// row carries. The raw IP is consumed into `visitor_hash` before a `NewEvent` exists, so it cannot
// reach here, and no new identifier is introduced. Retention is the one property mirroring COULD
// weaken, so `writeEvent` gates on it — see `AE_RETENTION_DAYS`.

import type { NewEvent } from '../db/queries.js';
import type { Env } from '../env.js';
import { createLogger } from './log.js';
import { retentionDays } from './retention.js';

/** A `NewEvent` column whose value is a string (or nullable string) — the only kind a blob can hold. */
type StringColumn = {
	[K in keyof NewEvent]-?: NonNullable<NewEvent[K]> extends string ? K : never;
}[keyof NewEvent];

/**
 * Positional blob layout. THIS IS APPEND-ONLY. Analytics Engine has no schema and no migrations:
 * `blobN` is addressed by position, and rows already written keep whatever meaning they had. Never
 * reorder a slot and never repurpose one — only ever append at the next free index, and only while
 * fewer than `MAX_BLOBS` are used.
 *
 * `bytes` caps each slot's UTF-8 length. The caps are far tighter than the wire schema allows (a
 * path validates to 2048 chars, a referrer likewise) because a truncated tail never changes which
 * group a row falls in for any query worth running, and the sum of the caps is what bounds a data
 * point below `MAX_BLOB_BYTES` for every possible event — including all-multibyte input, where a
 * character-based cap would silently pass three times its budget.
 *
 * Columns deliberately absent: `connection`, `screen_tier`, `orientation`, `dpr_class`. Each is a
 * fixed handful of enum values that D1 groups from an index in milliseconds, so mirroring them buys
 * nothing and spends a slot a genuinely high-cardinality dimension may need later.
 */
const BLOB_SCHEMA = [
	{ key: 'hostname', bytes: 253 },
	{ key: 'path', bytes: 1024 },
	{ key: 'referrer', bytes: 1024 },
	{ key: 'name', bytes: 128 },
	{ key: 'visitorHash', bytes: 64 },
	{ key: 'country', bytes: 8 },
	{ key: 'device', bytes: 20 },
	{ key: 'channel', bytes: 40 },
	{ key: 'browser', bytes: 40 },
	{ key: 'os', bytes: 40 },
	{ key: 'formFactor', bytes: 20 },
	{ key: 'region', bytes: 80 },
	{ key: 'city', bytes: 80 },
	{ key: 'timezone', bytes: 40 },
	{ key: 'network', bytes: 80 },
	{ key: 'language', bytes: 35 },
	{ key: 'utmSource', bytes: 200 },
	{ key: 'utmMedium', bytes: 200 },
	{ key: 'utmCampaign', bytes: 200 },
	{ key: 'currency', bytes: 3 },
] as const satisfies readonly { key: StringColumn; bytes: number }[];

/** A column this deployment actually mirrors — the key set of `BLOB_SCHEMA`, narrowed to literals so
 * a read can only ever name a slot the write path fills. */
export type MirroredColumn = (typeof BLOB_SCHEMA)[number]['key'];

/** The `blobN` column a mirrored key occupies, 1-based, derived from `BLOB_SCHEMA` itself. Reads go
 * through this so the layout has exactly ONE definition: appending a slot cannot leave a query
 * addressing the position the column used to hold. */
export function blobColumn(key: MirroredColumn): string {
	return `blob${BLOB_SCHEMA.findIndex((slot) => slot.key === key) + 1}`;
}

/** The `blobN` column carrying the derived visitor hash. Reads reference it ONLY inside
 * `count(DISTINCT …)`: it is the one mirrored column that identifies a browsing session rather than
 * describing it, so it must never become a group key or a projected value. */
export const VISITOR_BLOB = blobColumn('visitorHash');

/** The dataset name reads query in their `FROM` clause. The binding object exposes no name at
 * runtime, so this MUST stay equal to `analytics_engine_datasets[].dataset` in `wrangler.jsonc`; a
 * rename there without a change here queries a table that was never written to. */
export const AE_DATASET = 'facet_events';

/** Analytics Engine per-data-point limits: one index of at most 96 bytes, at most 20 blobs totalling
 * at most 16 KB, at most 20 doubles. Exported so the tests assert the layout stays inside them
 * rather than trusting that the caps were added up correctly by hand. */
export const MAX_INDEX_BYTES = 96;
export const MAX_BLOBS = 20;
export const MAX_BLOB_BYTES = 16 * 1024;
export const MAX_DOUBLES = 20;

/**
 * How long Analytics Engine keeps a data point. Cloudflare documents it as "three months" and offers
 * no delete API — a written point cannot be purged early, by Facet or by the operator.
 *
 * That makes retention the one privacy property the mirror could quietly weaken. A deployment that
 * sets `RAW_RETENTION_DAYS` BELOW this figure purges its D1 rows on the cron while the AE copy —
 * `visitor_hash` included — outlives them, so the deployment would be advertising a shorter window
 * than it can deliver. Rather than document that away, `writeEvent` refuses to mirror when the
 * configured window is shorter, which is the same rule the rest of the pipeline follows when two
 * settings contradict each other: misconfiguration degrades toward privacy.
 *
 * "Three months" is read here as 90 days, matching Facet's own default. The gate is about the
 * CONFIGURATION never claiming less than the mirror can honor; it cannot make Cloudflare's retention
 * land on an exact day, so a deployment that needs a day-exact guarantee should not bind AE at all.
 */
export const AE_RETENTION_DAYS = 90;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Truncate to at most `max` UTF-8 bytes without splitting a multi-byte code point: back off from the
 * cut while it lands on a continuation byte (`10xxxxxx`), so the result is always valid UTF-8. */
export function clampBytes(value: string, max: number): string {
	const bytes = encoder.encode(value);
	if (bytes.length <= max) return value;
	let end = max;
	while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--;
	return decoder.decode(bytes.subarray(0, end));
}

/** Build the blob row for an event. Analytics Engine has no NULL, so an absent dimension is the
 * empty string — a query distinguishes "unknown" with `blobN != ''`, the way `IS NULL` reads in D1. */
export function eventBlobs(row: NewEvent): string[] {
	return BLOB_SCHEMA.map((slot) => clampBytes(row[slot.key] ?? '', slot.bytes));
}

/**
 * Positional double layout, append-only for the same reason as the blobs.
 *   double1 — monetary value of the event (0 when it carried none).
 *   double2 — 1 when the event carried a value, else 0. Needed because AE cannot tell an absent
 *             value from a genuine 0, so average order value is SUM(double1 …) / SUM(double2 …).
 *   double3 — 1 when the event is a pageview, else 0. Mirrors D1's `name IS NULL` rule, so both
 *             stores answer "how many pageviews" identically.
 * Counts are sampling-corrected on read — SUM(_sample_interval * doubleN), never SUM(doubleN).
 */
export function eventDoubles(row: NewEvent): number[] {
	const value = typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null;
	return [value ?? 0, value === null ? 0 : 1, row.name === null ? 1 : 0];
}

/**
 * Mirror one derived event into Analytics Engine. No-ops when the binding is absent.
 *
 * Call this exactly ONCE per accepted event, at derive time. Analytics Engine has no idempotent
 * insert and no dedupe key, so writing from the persist path — which the queue redelivers
 * at-least-once — would inflate every retried batch. Derivation runs once per accepted request,
 * which is the latest point in the pipeline that is still free of redelivery. AE stamps its own
 * `timestamp` at write time, and derive time IS request time, so that column agrees with the D1
 * `created_at` beside it.
 */
export function writeEvent(env: Env, row: NewEvent): void {
	if (!env.AE) return;
	// A window shorter than AE's own un-purgeable one cannot be honored by a mirrored copy, so the
	// deployment stays D1-only rather than outliving the retention it advertises.
	if (retentionDays(env) < AE_RETENTION_DAYS) return;
	try {
		env.AE.writeDataPoint({
			// One index per data point, and it is what AE samples on — keying it to the site keeps
			// sampling per-tenant, so a high-traffic site can never sample a quiet one's events away.
			indexes: [clampBytes(row.siteId, MAX_INDEX_BYTES)],
			blobs: eventBlobs(row),
			doubles: eventDoubles(row),
		});
	} catch (err) {
		// The columnar mirror is best-effort and must never fail the request that produced the event:
		// D1 is authoritative, so a dropped data point costs analytical resolution, not data. Logged
		// rather than swallowed, so a systematically rejected write is visible instead of silent.
		createLogger({ component: 'ae' }).error('ae_write_failed', err, { site_id: row.siteId });
	}
}
