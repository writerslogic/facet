// Shared event-ingest types: the POST /api/collect payload and stored event shape.

/** JSON-safe value permitted inside custom-event `props`. */
export type PropValue = string | number | boolean | null;

/** Custom-event property bag. Keys are arbitrary; values are JSON scalars. */
export type EventProps = Record<string, PropValue>;

/** Body accepted by `POST /api/collect` (public beacon). */
export interface CollectPayload {
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

/** Distinguishes a pageview from a named custom event. */
export type EventKind = 'pageview' | 'event';

/** A raw event row as stored in D1 (`events` table). */
export interface StoredEvent {
	id: string;
	site_id: string;
	hostname: string;
	path: string;
	referrer: string;
	name: string | null;
	props: string | null;
	visitor_hash: string;
	country: string | null;
	device: string | null;
	created_at: number;
}
