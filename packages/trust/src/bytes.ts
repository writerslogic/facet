// Byte/encoding primitives shared across the trust package: concat, hex, base64, base64url, and
// SHA-256. Consolidated here so encoders are defined once (they were previously duplicated across
// mmr/multikey/sd/http-sig/vc). All Web Crypto / standard globals, so they run in workerd and Node.

const enc = new TextEncoder();

/** Concatenate byte parts into one buffer. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const buf = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		buf.set(p, off);
		off += p.length;
	}
	return buf;
}

/** SHA-256 of the concatenation of the given byte parts. */
export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', concatBytes(...parts)));
}

/** Hex-encode bytes (lowercase). */
export function toHex(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

/** Decode a hex string to bytes. Rejects odd length and non-hex characters rather than silently
 * mapping them to 0 — a malformed hex field must fail, not decode to valid-but-wrong bytes. */
export function fromHex(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error('hex string has an odd length');
	if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('hex string has a non-hex character');
	const out = new Uint8Array(hex.length / 2);
	for (let k = 0; k < out.length; k++) out[k] = Number.parseInt(hex.slice(k * 2, k * 2 + 2), 16);
	return out;
}

/** Byte-equality of two arrays. Constant time in the contents once the lengths match, so a caller
 * comparing a digest, MAC or signature cannot have it recovered byte-by-byte through timing. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let k = 0; k < a.length; k++) diff |= (a[k] as number) ^ (b[k] as number);
	return diff === 0;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;

/** The binary string (`String.fromCharCode` per byte) used by btoa. */
function toBinaryString(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return s;
}

/** Standard base64 encode (used by RFC 8941 Structured-Fields byte sequences). */
export function bytesToBase64(bytes: Uint8Array): string {
	return btoa(toBinaryString(bytes));
}

/** Standard base64 decode to bytes. Validated before `atob` because the WHATWG forgiving-base64
 * decode strips ASCII whitespace and tolerates a bad length, which would let one signature or key
 * field have many accepted spellings. Same rule as {@link fromHex}: malformed must fail, not decode. */
export function base64ToBytes(b64: string): Uint8Array {
	if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) throw new Error('invalid base64 string');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** base64url encode (no padding). */
export function bytesToBase64url(bytes: Uint8Array): string {
	return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url decode to bytes. The alphabet is checked before the mapping to standard base64, so a
 * value carrying `+` or `/` is rejected rather than silently accepted as its base64url twin. */
export function base64urlToBytes(b64u: string): Uint8Array {
	if (!BASE64URL_RE.test(b64u)) throw new Error('invalid base64url string');
	const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
	return base64ToBytes(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
}

/** UTF-8 encode a string. */
export function utf8(s: string): Uint8Array {
	return enc.encode(s);
}
