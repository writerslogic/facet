// Runtime validation schemas (valibot) — the single source of truth for request shapes.
// Server validates against these; TS types are derived from them so the wire contract can
// never drift between client, server, and dashboard. Full field rules land in T003.

import * as v from 'valibot';

/** Custom-event property value: a JSON scalar. */
export const PropValueSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

/** Body accepted by `POST /api/collect`. */
export const CollectPayloadSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	hostname: v.pipe(v.string(), v.maxLength(253)),
	path: v.pipe(v.string(), v.maxLength(2048)),
	referrer: v.pipe(v.string(), v.maxLength(2048)),
	name: v.optional(v.pipe(v.string(), v.maxLength(128))),
	props: v.optional(v.record(v.string(), PropValueSchema)),
});
