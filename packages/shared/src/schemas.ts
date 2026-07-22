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
});

export const StatsQuerySchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	hostname: v.optional(v.pipe(v.string(), v.maxLength(253))),
	start: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
	end: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
	interval: v.optional(v.picklist(['hour', 'day'])),
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
