// Wire-level valibot schemas + inferred types. The single validation source of truth for the
// collect, stats-query, and admin wire contracts, with every limit fixed here. Zero runtime deps
// beyond valibot.

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

// First-party server-to-server event: same shape as the beacon minus site_id (which comes from the
// API key), plus optional ip/user_agent so the caller can attribute the end-user's visit.
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
	ip: v.optional(v.pipe(v.string(), v.maxLength(45))),
	user_agent: v.optional(v.pipe(v.string(), v.maxLength(512))),
});

export const StatsQuerySchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	hostname: v.optional(v.pipe(v.string(), v.maxLength(253))),
	start: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
	end: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
	interval: v.optional(v.picklist(['hour', 'day'])),
});

// Constrained natural-language query intent. The LLM only ever emits a value matching this schema;
// the executor maps it onto existing aggregate helpers. Never used to build SQL from model text.
export const QueryIntentSchema = v.object({
	metric: v.picklist(['pageviews', 'visitors', 'events', 'sessions', 'bounce_rate']),
	dimension: v.optional(v.picklist(['path', 'referrer', 'country', 'device', 'channel'])),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
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
