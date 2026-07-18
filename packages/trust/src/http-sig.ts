// RFC 9421 HTTP Message Signatures for signing a response body. We cover two message components —
// `content-digest` (RFC 9530, SHA-256 of the body) and `content-type` — plus the standard signature
// parameters (created/keyid/alg). Signatures are raw (not JWS): Ed25519 over the signature base, or
// ECDSA P-256/SHA-256 producing the IEEE-P1363 r||s form RFC 9421 requires. All via Web Crypto so it
// runs in workerd. This is offered alongside detached JWS as a second, HTTP-native integrity option.

import type { JWK, KeyLike } from 'jose';
import { type SigningKey, importPublicJwk } from './keys.js';

/** Covered components, in signature-base order. Kept fixed so signer and verifier agree. */
const COMPONENTS = ['content-digest', 'content-type'] as const;

/** Default Structured-Fields label for the signature (`sig1`). */
const DEFAULT_LABEL = 'sig1';

/** Map our JWS alg to the RFC 9421 algorithm registry label. */
function rfc9421Alg(alg: SigningKey['alg']): 'ed25519' | 'ecdsa-p256-sha256' {
	return alg === 'EdDSA' ? 'ed25519' : 'ecdsa-p256-sha256';
}

/** Web Crypto sign/verify parameters for a given RFC 9421 alg. */
function subtleParams(
	alg: 'ed25519' | 'ecdsa-p256-sha256',
): { name: 'Ed25519' } | { name: 'ECDSA'; hash: 'SHA-256' } {
	return alg === 'ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
}

/** The Web Crypto key type `crypto.subtle.sign` expects, derived from the runtime so we don't depend
 * on the `CryptoKey` global type name being exported (it isn't under @types/node). */
type SubtleKey = Parameters<typeof crypto.subtle.sign>[1];

/** Narrow a jose KeyLike to a Web Crypto key (required for raw RFC 9421 sign/verify). Uses a
 * structural check so this compiles under both Node (@types/node) and workerd type environments — a
 * Node KeyObject lacks the `extractable` property a Web Crypto key always has. */
function requireCryptoKey(key: KeyLike): SubtleKey {
	if (typeof (key as { extractable?: unknown }).extractable !== 'boolean') {
		throw new Error('RFC 9421 requires a Web Crypto CryptoKey (available under workerd)');
	}
	return key as SubtleKey;
}

/** Standard base64 encode (Structured-Fields byte sequences use base64, not base64url). */
function b64(bytes: Uint8Array): string {
	let s = '';
	for (const byte of bytes) s += String.fromCharCode(byte);
	return btoa(s);
}

/** Standard base64 decode to bytes. */
function unb64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** RFC 9530 Content-Digest value for a body: `sha-256=:<base64>:`. */
async function contentDigest(body: Uint8Array): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
	return `sha-256=:${b64(hash)}:`;
}

/** Build the signature-params inner list + parameters, e.g. `("content-digest" "content-type");created=…`. */
function signatureParams(created: number, keyid: string, alg: string): string {
	const inner = COMPONENTS.map((c) => `"${c}"`).join(' ');
	return `(${inner});created=${created};keyid="${keyid}";alg="${alg}"`;
}

/** Build the RFC 9421 §2.5 signature base string from component values + params. */
function signatureBase(values: Record<string, string>, params: string): string {
	const lines = COMPONENTS.map((c) => `"${c}": ${values[c]}`);
	lines.push(`"@signature-params": ${params}`);
	return lines.join('\n');
}

/** The three response headers that carry an RFC 9421 signature. */
export interface HttpSignatureHeaders {
	'content-digest': string;
	'signature-input': string;
	signature: string;
}

export interface SignResponseInput {
	body: Uint8Array;
	contentType: string;
	created: number;
	key: SigningKey;
	label?: string;
}

/** Sign a response body, returning the Content-Digest, Signature-Input, and Signature headers. */
export async function signResponse(input: SignResponseInput): Promise<HttpSignatureHeaders> {
	const label = input.label ?? DEFAULT_LABEL;
	const alg = rfc9421Alg(input.key.alg);
	// RFC 9421 raw signing goes through Web Crypto, which needs a CryptoKey (present under workerd).
	const privateKey = requireCryptoKey(input.key.privateKey);
	const digest = await contentDigest(input.body);
	const params = signatureParams(input.created, input.key.kid, alg);
	const base = signatureBase(
		{ 'content-digest': digest, 'content-type': input.contentType },
		params,
	);
	const sig = new Uint8Array(
		await crypto.subtle.sign(subtleParams(alg), privateKey, new TextEncoder().encode(base)),
	);
	return {
		'content-digest': digest,
		'signature-input': `${label}=${params}`,
		signature: `${label}=:${b64(sig)}:`,
	};
}

/** Parse a `label=<params>` Signature-Input into its label and params string. */
function parseSignatureInput(input: string): { label: string; params: string } {
	const eq = input.indexOf('=');
	if (eq < 0) throw new Error('malformed Signature-Input');
	return { label: input.slice(0, eq), params: input.slice(eq + 1) };
}

/** Extract the base64 signature bytes for `label` from a Signature header. */
function parseSignature(header: string, label: string): Uint8Array {
	const m = header.match(new RegExp(`${label}=:([^:]+):`));
	if (!m?.[1]) throw new Error('signature not found for label');
	return unb64(m[1]);
}

/** Pull `keyid` / `alg` out of a signature-params string for cross-checking against the JWK. */
export function parseSignatureParams(params: string): {
	keyid?: string;
	alg?: string;
	created?: number;
} {
	const keyid = params.match(/keyid="([^"]+)"/)?.[1];
	const alg = params.match(/alg="([^"]+)"/)?.[1];
	const created = params.match(/created=(\d+)/)?.[1];
	return { keyid, alg, created: created ? Number(created) : undefined };
}

export interface VerifyResponseInput {
	body: Uint8Array;
	contentType: string;
	contentDigest: string;
	signatureInput: string;
	signature: string;
	publicJwk: JWK;
}

/** Verify an RFC 9421-signed response. Recomputes the digest + base and checks the raw signature. */
export async function verifyResponse(input: VerifyResponseInput): Promise<boolean> {
	// The Content-Digest must actually match the body, else a valid signature over a stale digest passes.
	const expectedDigest = await contentDigest(input.body);
	if (expectedDigest !== input.contentDigest) return false;

	const { label, params } = parseSignatureInput(input.signatureInput);
	const { alg } = parseSignatureParams(params);
	if (alg !== 'ed25519' && alg !== 'ecdsa-p256-sha256') return false;

	const base = signatureBase(
		{
			'content-digest': input.contentDigest,
			'content-type': input.contentType,
		},
		params,
	);
	const sig = parseSignature(input.signature, label);
	const { key } = await importPublicJwk(input.publicJwk);
	const publicKey = requireCryptoKey(key);
	return crypto.subtle.verify(subtleParams(alg), publicKey, sig, new TextEncoder().encode(base));
}
