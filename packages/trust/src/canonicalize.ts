// JSON Canonicalization Scheme (RFC 8785 / JCS): a deterministic byte serialization so a signer and
// a verifier agree on exactly what was signed regardless of key order or incidental whitespace. Keys
// are sorted by UTF-16 code unit, strings use JSON escaping, and finite numbers use the ECMAScript
// Number-to-String form — which `JSON.stringify` produces, so this is RFC 8785 conformant for every
// finite JSON number, exponent forms included (see canonicalize.test.ts §3.2.2/§3.2.3 vectors).
// Reused for detached-JWS export proofs and the eddsa-jcs Data Integrity suite.

import { sha256, toHex } from './bytes.js';

/** Canonicalize a JSON value to its RFC 8785 string form. Rejects non-finite numbers. */
export function canonicalizeJson(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error('cannot canonicalize a non-finite number');
		return JSON.stringify(value);
	}
	if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((v) => canonicalizeJson(v)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj)
			.filter((k) => obj[k] !== undefined)
			.sort();
		const members = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
		return `{${members.join(',')}}`;
	}
	throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

/** Canonicalize a JSON value to UTF-8 bytes (the input to signing/hashing). */
export function canonicalizeBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(canonicalizeJson(value));
}

/** SHA-256 of a value's canonical (RFC 8785) bytes — the "hash the canonical form" idiom used across
 * VC Data Integrity, RATS evidence, SCITT statements, and selective disclosure, in one place. */
export function canonicalDigest(value: unknown): Promise<Uint8Array> {
	return sha256(canonicalizeBytes(value));
}

/** Hex-encoded {@link canonicalDigest}. */
export async function canonicalDigestHex(value: unknown): Promise<string> {
	return toHex(await canonicalDigest(value));
}
