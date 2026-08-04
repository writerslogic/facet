// Wire-level valibot schemas + inferred types: the validation source of truth for the collect,
// stats-query, and admin contracts.

import * as v from 'valibot';

export const PROPS_MAX_KEYS = 24;
export const PROPS_KEY_MAX_LEN = 40;
export const PROPS_STR_MAX_LEN = 500;

export const PropValueSchema = v.union([
	v.pipe(v.string(), v.maxLength(PROPS_STR_MAX_LEN)),
	v.pipe(v.number(), v.finite()),
	v.boolean(),
	v.null(),
]);

export const PropsSchema = v.pipe(
	v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(PROPS_KEY_MAX_LEN)), PropValueSchema),
	v.check((o) => Object.keys(o).length <= PROPS_MAX_KEYS, 'too_many_props'),
);

export const CollectPayloadSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	hostname: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
	path: v.pipe(
		v.string(),
		v.minLength(1),
		v.maxLength(2048),
		v.regex(/^\//, 'path_must_be_absolute'),
	),
	referrer: v.pipe(v.string(), v.maxLength(2048)),
	name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
	props: v.optional(PropsSchema),
	utm: v.optional(
		v.object({
			source: v.optional(v.pipe(v.string(), v.maxLength(200))),
			medium: v.optional(v.pipe(v.string(), v.maxLength(200))),
			campaign: v.optional(v.pipe(v.string(), v.maxLength(200))),
		}),
	),
	// Viewport signals the tracker buckets ON-DEVICE before sending — never the raw resolution/DPR, so no
	// fingerprint-grade value ever leaves the browser. Anything off the allowlist is dropped server-side.
	screen: v.optional(v.picklist(['phone', 'tablet', 'laptop', 'desktop', 'ultrawide'])),
	orientation: v.optional(v.picklist(['portrait', 'landscape'])),
	dpr: v.optional(v.picklist(['1x', '2x', '3x'])),
});

// First-party server-to-server event: beacon shape minus site_id (taken from the API key), plus
// optional ip/user_agent to attribute the end-user's visit.
export const ServerEventSchema = v.object({
	hostname: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
	path: v.pipe(
		v.string(),
		v.minLength(1),
		v.maxLength(2048),
		v.regex(/^\//, 'path_must_be_absolute'),
	),
	referrer: v.optional(v.pipe(v.string(), v.maxLength(2048))),
	name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
	props: v.optional(PropsSchema),
	utm: v.optional(
		v.object({
			source: v.optional(v.pipe(v.string(), v.maxLength(200))),
			medium: v.optional(v.pipe(v.string(), v.maxLength(200))),
			campaign: v.optional(v.pipe(v.string(), v.maxLength(200))),
		}),
	),
	ip: v.optional(v.pipe(v.string(), v.ip())),
	user_agent: v.optional(v.pipe(v.string(), v.maxLength(512))),
	// Tier 2 (identified) attempt: a site-supplied opaque user id + a per-event consent assertion.
	// Both are only honored when the site is configured `identified` AND `consent === true`; otherwise
	// the uid is ignored and the event ingests anonymously (misconfiguration degrades toward privacy).
	user_id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
	consent: v.optional(v.boolean()),
});

// Identity spectrum (U2). `salt_window` widens the pseudonym's linkage lifetime; `never` is
// intentionally absent — every window is bounded by retention, so cross-window linkage is always
// finite. Tiers are monotonic: an elevated site still emits the Tier-0 anonymous aggregates.
export const IdentityTierSchema = v.picklist(['anonymous', 'pseudonymous', 'identified']);
export const SaltWindowSchema = v.picklist(['day', 'week', 'month']);

// Admin: set a site's identity tier + salt window (site_id comes from the path, never the body).
export const SetIdentitySchema = v.object({
	tier: IdentityTierSchema,
	salt_window: SaltWindowSchema,
});

// Consent grant (site API key path). `site_id` is derived from the key, NEVER the body. `ip`/`ua` are
// transient — used only to re-derive the same visitor hash the ingest path will, never stored. The
// stored/signed record contains only the derived hash, never ip/ua/raw user_id.
export const ConsentGrantSchema = v.pipe(
	v.object({
		tier: v.picklist(['pseudonymous', 'identified']),
		salt_window: SaltWindowSchema,
		user_id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
		ip: v.optional(v.pipe(v.string(), v.ip())),
		user_agent: v.optional(v.pipe(v.string(), v.maxLength(512))),
		expires_at: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	}),
	v.check(
		(b) => b.tier !== 'identified' || (b.user_id?.length ?? 0) > 0,
		'user_id_required_for_identified',
	),
);

export const ConsentRevokeSchema = v.pipe(
	v.object({
		tier: v.picklist(['pseudonymous', 'identified']),
		salt_window: SaltWindowSchema,
		user_id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
		ip: v.optional(v.pipe(v.string(), v.ip())),
		user_agent: v.optional(v.pipe(v.string(), v.maxLength(512))),
	}),
	v.check(
		(b) => (b.user_id?.length ?? 0) > 0 || (b.ip?.length ?? 0) > 0,
		'revoke_needs_identifier',
	),
);

export const StatsQuerySchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	hostname: v.optional(v.pipe(v.string(), v.maxLength(253))),
	start: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
	end: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
	interval: v.optional(v.picklist(['hour', 'day'])),
	// Optional exact-match dimension filters: narrow every Overview number to rows matching the
	// given path/referrer/country/device/channel (see toStatsFilter → buildFilteredEventWhere).
	path: v.optional(v.pipe(v.string(), v.maxLength(2048))),
	referrer: v.optional(v.pipe(v.string(), v.maxLength(2048))),
	country: v.optional(v.pipe(v.string(), v.maxLength(8))),
	device: v.optional(v.pipe(v.string(), v.maxLength(20))),
	channel: v.optional(v.pipe(v.string(), v.maxLength(40))),
});

/** A query-string integer bounded to `[min, max]`. Query params arrive as strings, so the transform
 * happens before the numeric checks — same pipeline shape as `StatsQuerySchema.start`. */
function boundedIntParam(min: number, max: number) {
	return v.pipe(
		v.string(),
		v.transform(Number),
		v.number(),
		v.integer(),
		v.minValue(min),
		v.maxValue(max),
	);
}

/** Upper bound on the lines a per-dimension time series may return. A multi-line chart stops being
 * readable well before this, and it is what bounds the response to `limit × buckets` points. */
export const SERIES_MAX_KEYS = 8;

/** Query for `GET /api/stats/timeseries`: the stats query plus which dimension to split by and how
 * many keys to return. `dimension` is required — there is no sensible default, and guessing one
 * would silently answer a different question than the caller asked. */
export const DimensionSeriesQuerySchema = v.object({
	...StatsQuerySchema.entries,
	dimension: v.picklist(['path', 'referrer', 'country', 'device', 'channel']),
	limit: v.optional(boundedIntParam(1, SERIES_MAX_KEYS)),
});

/**
 * Every dimension `GET /api/stats/breakdown` can group by — one per column the columnar mirror
 * carries, so the endpoint answers identically whichever store serves it.
 *
 * `visitor_hash` is mirrored too and is deliberately NOT here: it is the one column that identifies
 * a browsing session rather than describing it, and grouping by it would return one row per person.
 * The four enum-shaped columns D1 keeps but does not mirror (screen tier, connection, orientation,
 * DPR class) are absent for the opposite reason — `/api/stats` already breaks them down.
 */
export const BREAKDOWN_DIMENSIONS = [
	'hostname',
	'path',
	'referrer',
	'event',
	'country',
	'region',
	'city',
	'timezone',
	'network',
	'language',
	'device',
	'form_factor',
	'browser',
	'os',
	'channel',
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'currency',
] as const;

export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

/** Upper bound on breakdown rows. Higher than the fixed top-N lists on `/api/stats` because the
 * point of this endpoint is the long tail, but still a constant rather than the data's cardinality. */
export const BREAKDOWN_MAX_ROWS = 200;

/** Default breakdown depth when the caller does not ask for one. */
export const BREAKDOWN_DEFAULT_ROWS = 25;

/** Query for `GET /api/stats/breakdown`: the stats query plus which dimension to group by. The same
 * `path`/`referrer`/`country`/`device`/`channel` filters narrow it as they do everywhere else. */
export const BreakdownQuerySchema = v.object({
	...StatsQuerySchema.entries,
	dimension: v.picklist(BREAKDOWN_DIMENSIONS),
	limit: v.optional(boundedIntParam(1, BREAKDOWN_MAX_ROWS)),
});

// Constrained natural-language query intent: the LLM only emits a value matching this schema, which
// the executor maps onto existing aggregate helpers. Never used to build SQL from model text.
export const QueryIntentSchema = v.object({
	metric: v.picklist(['pageviews', 'visitors', 'events', 'sessions', 'bounce_rate']),
	dimension: v.optional(v.picklist(['path', 'referrer', 'country', 'device', 'channel'])),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
	/** When true, return a time-series/trend instead of a scalar (ignored if a dimension is set). */
	series: v.optional(v.boolean()),
	interval: v.optional(v.picklist(['hour', 'day'])),
});

export const CreateSiteSchema = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	domain: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
});

export const IssueKeySchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	label: v.optional(v.pipe(v.string(), v.maxLength(100))),
});

export const GoalSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	type: v.picklist(['event', 'path']),
	match_value: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
});

export const FunnelStepSchema = v.object({
	type: v.picklist(['event', 'path']),
	match_value: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
});

export const FunnelSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	steps: v.pipe(v.array(FunnelStepSchema), v.minLength(2), v.maxLength(10)),
});

export const ExperimentVariantSchema = v.object({
	key: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
	weight: v.pipe(v.number(), v.minValue(0)),
});

export const ExperimentSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	flag_key: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
	variants: v.pipe(v.array(ExperimentVariantSchema), v.minLength(2), v.maxLength(8)),
	active: v.optional(v.boolean()),
});

// Feature flags. Weights are integer basis points (0..10000) for byte-exact cross-runtime bucketing;
// the handler additionally enforces sum == 10000 and serve-keys ⊆ variants (not expressible in valibot).
export const FlagVariantSchema = v.object({
	key: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
	weight: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10000)),
});

const FlagClauseSchema = v.object({
	attr: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
	op: v.picklist(['eq', 'neq', 'in', 'nin', 'contains', 'prefix', 'gte', 'lte', 'pct']),
	value: v.union([
		v.pipe(v.string(), v.maxLength(500)),
		v.number(),
		v.pipe(v.array(v.pipe(v.string(), v.maxLength(200))), v.maxLength(100)),
	]),
});

const FlagServeSchema = v.union([
	v.object({ variant: v.pipe(v.string(), v.minLength(1), v.maxLength(60)) }),
	v.object({
		rollout: v.pipe(v.array(FlagVariantSchema), v.minLength(1), v.maxLength(8)),
	}),
]);

export const FlagRuleSchema = v.object({
	priority: v.pipe(v.number(), v.integer(), v.minValue(0)),
	clauses: v.pipe(v.array(FlagClauseSchema), v.maxLength(10)),
	serve: FlagServeSchema,
});

export const FlagSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	flag_key: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	type: v.picklist(['boolean', 'multivariate']),
	enabled: v.optional(v.boolean()),
	default_variant: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
	variants: v.pipe(v.array(FlagVariantSchema), v.minLength(1), v.maxLength(8)),
	rules: v.optional(v.pipe(v.array(FlagRuleSchema), v.maxLength(20))),
});

// Public eval body (site API key path). `custom` is bounded (reusing the props limits) because it is
// visitor-asserted and unauthenticated; `gpc` lets a server-tier caller forward the visitor's opt-out.
export const FlagEvalSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
	keys: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(60))), v.maxLength(100))),
	gpc: v.optional(v.boolean()),
	ctx: v.optional(
		v.object({
			country: v.optional(v.pipe(v.string(), v.maxLength(8))),
			device: v.optional(v.pipe(v.string(), v.maxLength(20))),
			path: v.optional(v.pipe(v.string(), v.maxLength(2048))),
			host: v.optional(v.pipe(v.string(), v.maxLength(253))),
			channel: v.optional(v.pipe(v.string(), v.maxLength(40))),
			lang: v.optional(v.pipe(v.string(), v.maxLength(35))),
			custom: v.optional(
				v.pipe(
					v.record(
						v.pipe(v.string(), v.minLength(1), v.maxLength(PROPS_KEY_MAX_LEN)),
						v.union([v.pipe(v.string(), v.maxLength(PROPS_STR_MAX_LEN)), v.number()]),
					),
					v.check(
						(o) => Object.keys(o).length <= PROPS_MAX_KEYS,
						'too_many_custom_attrs',
					),
				),
			),
		}),
	),
});

export type QueryIntent = v.InferOutput<typeof QueryIntentSchema>;
export type CollectInput = v.InferOutput<typeof CollectPayloadSchema>;
export type ServerEventInput = v.InferOutput<typeof ServerEventSchema>;
export type StatsQueryInput = v.InferOutput<typeof StatsQuerySchema>;
export type DimensionSeriesQueryInput = v.InferOutput<typeof DimensionSeriesQuerySchema>;
export type BreakdownQueryInput = v.InferOutput<typeof BreakdownQuerySchema>;
export type CreateSiteInput = v.InferOutput<typeof CreateSiteSchema>;
export type IssueKeyInput = v.InferOutput<typeof IssueKeySchema>;
export type GoalInput = v.InferOutput<typeof GoalSchema>;
export type FunnelStepInput = v.InferOutput<typeof FunnelStepSchema>;
export type FunnelInput = v.InferOutput<typeof FunnelSchema>;
export type ExperimentVariantInput = v.InferOutput<typeof ExperimentVariantSchema>;
export type ExperimentInput = v.InferOutput<typeof ExperimentSchema>;
export type FlagVariantInput = v.InferOutput<typeof FlagVariantSchema>;
export type FlagRuleInput = v.InferOutput<typeof FlagRuleSchema>;
export type FlagInput = v.InferOutput<typeof FlagSchema>;
export type FlagEvalInput = v.InferOutput<typeof FlagEvalSchema>;
export type IdentityTier = v.InferOutput<typeof IdentityTierSchema>;
export type SaltWindow = v.InferOutput<typeof SaltWindowSchema>;
export type SetIdentityInput = v.InferOutput<typeof SetIdentitySchema>;
export type ConsentGrantInput = v.InferOutput<typeof ConsentGrantSchema>;
export type ConsentRevokeInput = v.InferOutput<typeof ConsentRevokeSchema>;
