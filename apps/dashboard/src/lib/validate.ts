// Credential validation for the KeyGate and profile forms. Lenient enough not to reject legitimate
// future formats: an API key must start with `clk_`, a Site ID must be UUID-shaped. Returns a
// human-readable message string, or null when valid.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate an API key. Returns an error message, or null when acceptable. */
export function validateApiKey(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return 'Enter your API key.';
	if (!trimmed.startsWith('clk_')) return 'API key should start with "clk_".';
	return null;
}

/** Validate a Site ID. Returns an error message, or null when acceptable. */
export function validateSiteId(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return 'Enter your Site ID.';
	if (!UUID_RE.test(trimmed)) return 'Site ID should be a UUID (e.g. xxxxxxxx-xxxx-4xxx-…).';
	return null;
}
