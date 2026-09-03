// Shared event-ingest types. IMPORTANT: `schemas.ts` holds the validated wire contract
// (`CollectPayloadSchema`); nothing here is a substitute for parsing against it.

/** JSON-safe value permitted inside custom-event `props`. */
export type PropValue = string | number | boolean | null;

/** Custom-event property bag. Keys are arbitrary; values are JSON scalars. */
export type EventProps = Record<string, PropValue>;

/** Core fields of the `POST /api/collect` body. `CollectPayloadSchema` is the complete contract. */
export interface CollectPayload {
	/** Per-event UUID, reused only when retrying the same event. */
	event_id?: string;
	/** UUID of the site this event belongs to. */
	site_id: string;
	/** Hostname the event was fired from (e.g. "example.com"). */
	hostname: string;
	/** Path of the page (e.g. "/pricing"). */
	path: string;
	/** Full or empty referrer URL. */
	referrer: string;
	/** Custom event name. Absent/empty => pageview. */
	name?: string;
	/** Optional custom-event properties. */
	props?: EventProps;
}
