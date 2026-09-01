// Timeline annotations: operator-authored context layered over the traffic chart. These records are
// site configuration, not tracked visitor data. Writes are admin-only; aggregate-read credentials
// may list them for the same site so the Overview can explain traffic changes without gaining any
// broader mutation authority.

import * as v from 'valibot';

/** A small fixed taxonomy keeps chart markers distinguishable without turning labels into metadata. */
export const TIMELINE_ANNOTATION_CATEGORIES = ['note', 'release', 'campaign', 'incident'] as const;
export type TimelineAnnotationCategory = (typeof TIMELINE_ANNOTATION_CATEGORIES)[number];

/** IMPORTANT: `safeInteger` alone admits instants past the ECMAScript maximum time value, and
 * `new Date(occurred_at).toISOString()` in the chart renderer throws a RangeError on those. */
const MAX_TIME_VALUE = 8_640_000_000_000_000;

/** Admin body for `POST /api/annotations`. The timestamp is an instant in unix milliseconds. */
export const TimelineAnnotationSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
	category: v.optional(v.picklist(TIMELINE_ANNOTATION_CATEGORIES)),
	occurred_at: v.pipe(
		v.number(),
		v.finite(),
		v.safeInteger(),
		v.minValue(0),
		v.maxValue(MAX_TIME_VALUE),
	),
});

export type TimelineAnnotationInput = v.InferOutput<typeof TimelineAnnotationSchema>;

/** Stored/public timeline note. Labels are operator-supplied and must never be written to logs. */
export interface TimelineAnnotation {
	id: string;
	site_id: string;
	label: string;
	category: TimelineAnnotationCategory;
	occurred_at: number;
	created_at: number;
}

export interface TimelineAnnotationsResponse {
	annotations: TimelineAnnotation[];
}
