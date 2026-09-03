// Server-only constants. Single source of truth — import from here, never redeclare.

/** Delimiter used between fields when building the visitor hash input. */
export const HASH_DELIMITER = '|' as const;

/** Number of random bytes used to generate a daily salt (stored as lowercase hex). */
export const SALT_BYTES = 32 as const;

/** Default rolling retention window for raw events, in days. */
export const DEFAULT_RAW_RETENTION_DAYS = 90 as const;

/** CORS max-age for preflight responses, in seconds. */
export const CORS_MAX_AGE = 86400 as const;

/** Maximum accepted body size for a `POST /api/collect` beacon, in bytes. */
export const COLLECT_MAX_BODY_BYTES = 8192 as const;

/** Prefix on every issued API key (Facet key). */
export const API_KEY_PREFIX = 'clk_' as const;

/** Random bytes in an API key (rendered as hex after the prefix). */
export const API_KEY_BYTES = 32 as const;

/** Maximum queryable stats range, in days. */
export const MAX_RANGE_DAYS = 90 as const;

/** One hour in milliseconds. */
export const HOUR_MS = 3_600_000 as const;

/** One day in milliseconds. */
export const DAY_MS = 86_400_000 as const;

/** Inactivity gap after which a new session starts, in milliseconds (30 minutes). */
export const SESSION_TIMEOUT_MS = 1_800_000 as const;

/** Signed z-score threshold at/above which a bucket is flagged as anomalous. */
export const ANOMALY_Z = 3.0 as const;

/** Minimum number of baseline buckets required before an anomaly can be scored. */
export const ANOMALY_MIN_BASELINE = 3 as const;

/** Maximum rows a single breakdown export may request (bounded output). */
export const EXPORT_MAX_ROWS = 1000 as const;

/** Trailing window for the realtime "active visitors" metric, in milliseconds (5 minutes). */
export const REALTIME_WINDOW_MS = 300_000 as const;

/**
 * How many values one `IN (...)` list may carry.
 *
 * D1 rejects any statement with more than 100 bound parameters ("too many SQL variables"), and every
 * such query spends some of that budget on its other predicates — a site id, a timestamp, a limit. So
 * the list gets a margin rather than the whole allowance, and anything longer is chunked across
 * statements. This is not a tuning knob: exceed it and the query does not run slowly, it fails.
 */
export const D1_MAX_IN_PARAMS = 90 as const;

/** Split `values` into runs of at most `size`, for queries whose `IN (...)` list would otherwise
 * exceed D1's bound-parameter limit. An empty input yields no chunks, so a caller can iterate the
 * result without a special case for "nothing to look up". */
export function chunked<T>(values: readonly T[], size: number = D1_MAX_IN_PARAMS): T[][] {
	// IMPORTANT: a size below 1 never advances the cursor, so the loop below never terminates and
	// grows `out` until the isolate dies. Fail loudly instead.
	if (!Number.isInteger(size) || size < 1) {
		throw new RangeError('chunked: size must be a positive integer');
	}
	const out: T[][] = [];
	for (let i = 0; i < values.length; i += size) {
		out.push(values.slice(i, i + size));
	}
	return out;
}
