// Server-only constants. Single source of truth — import from here, never redeclare.

/** Delimiter used between fields when building the visitor hash input. */
export const HASH_DELIMITER = '|' as const;

/** Number of random bytes used to generate a daily salt (stored as lowercase hex). */
export const SALT_BYTES = 32 as const;

/** Default rolling retention window for raw events, in days. */
export const DEFAULT_RAW_RETENTION_DAYS = 90 as const;

/** CORS max-age for preflight responses, in seconds. */
export const CORS_MAX_AGE = 86400 as const;

/** HTTP status code returned for a successful CORS preflight. */
export const PREFLIGHT_STATUS = 204 as const;
