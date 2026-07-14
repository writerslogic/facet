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

/** HTTP status code returned for a successful CORS preflight. */
export const PREFLIGHT_STATUS = 204 as const;

/** Prefix on every issued API key (Countless key). */
export const API_KEY_PREFIX = 'clk_' as const;

/** Random bytes in an API key (rendered as hex after the prefix). */
export const API_KEY_BYTES = 32 as const;

/** Maximum queryable stats range, in days. */
export const MAX_RANGE_DAYS = 90 as const;

/** One hour in milliseconds. */
export const HOUR_MS = 3_600_000 as const;

/** One day in milliseconds. */
export const DAY_MS = 86_400_000 as const;
