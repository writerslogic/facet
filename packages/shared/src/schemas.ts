// Wire-level valibot schemas + inferred types. The single source of truth for the collect
// payload wire contract. Zero runtime deps beyond valibot.

import * as v from 'valibot';

export const PropValueSchema = v.union([v.string(), v.number(), v.boolean()]);

export const EventPropsSchema = v.record(v.string(), PropValueSchema);

export const UtmSchema = v.object({
	source: v.optional(v.pipe(v.string(), v.maxLength(200))),
	medium: v.optional(v.pipe(v.string(), v.maxLength(200))),
	campaign: v.optional(v.pipe(v.string(), v.maxLength(200))),
});

export const CollectPayloadSchema = v.object({
	siteId: v.pipe(v.string(), v.maxLength(200)),
	url: v.pipe(v.string(), v.maxLength(2000)),
	referrer: v.optional(v.pipe(v.string(), v.maxLength(2000))),
	name: v.optional(v.pipe(v.string(), v.maxLength(200))),
	props: v.optional(EventPropsSchema),
	utm: v.optional(UtmSchema),
});

export type CollectInput = v.InferInput<typeof CollectPayloadSchema>;
