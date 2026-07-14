// Shared admin entity types: the public row shapes for sites and API keys. An API key's plaintext
// and hash are never part of any returned type.

/** A tracked site. */
export interface Site {
	id: string;
	name: string;
	domain: string;
	created_at: number;
}

/** An API key as returned by admin list endpoints — never the key or its hash. */
export interface ApiKeyRecord {
	id: string;
	site_id: string;
	label: string | null;
	created_at: number;
	last_used: number | null;
}
