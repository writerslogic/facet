// Canonical encoding / digest primitives. The single source for hex, SHA-256, random-hex, and
// constant-time hex comparison — no other module re-implements these (see the DRY mandate).

/** Lowercase-hex encode a byte array. */
export function toHex(bytes: Uint8Array): string {
	let hex = '';
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, '0');
	}
	return hex;
}

/** SHA-256 of a UTF-8 string, returned as 64 lowercase hex chars. */
export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return toHex(new Uint8Array(digest));
}

/** `bytes` cryptographically-random bytes, returned as lowercase hex. */
export function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return toHex(buf);
}

/** Length-safe, constant-time comparison of two hex strings. */
export function constantTimeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
