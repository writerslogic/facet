// Random identifier for UI keys (board slot uids, profile ids). Uses the Web Crypto API only — no
// Math.random — so it satisfies static analysis and gives collision-resistant ids everywhere the app
// runs (browsers + the Cloudflare Worker both provide `crypto`).

export function randomId(): string {
	const c = globalThis.crypto;
	if (c?.randomUUID) return c.randomUUID();
	const bytes = new Uint8Array(10);
	c.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
