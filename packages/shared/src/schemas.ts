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
});

export const StatsQuerySchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	hostname: v.optional(v.pipe(v.string(), v.maxLength(253))),
	start: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
	end: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
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

export type CollectInput = v.InferOutput<typeof CollectPayloadSchema>;
export type StatsQueryInput = v.InferOutput<typeof StatsQuerySchema>;
export type CreateSiteInput = v.InferOutput<typeof CreateSiteSchema>;
export type IssueKeyInput = v.InferOutput<typeof IssueKeySchema>;
