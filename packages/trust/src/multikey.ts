// Multikey / publicKeyMultibase encoding for Ed25519 (Controlled Identifiers v1.0), used by the
// Data Integrity eddsa-jcs-2022 verification method and did:web/did:key documents. An Ed25519
// public key is `base58btc('z' + 0xed01 || rawPublicKey)`. Only Ed25519 is supported here; the
// eddsa cryptosuite is Ed25519-only (ES256 deployments use JWS/JWKS paths, not Data Integrity).

import type { JWK } from 'jose';
import { base58decode, base58encode } from './base58.js';

/** Multicodec prefix for an Ed25519 public key (0xed 0x01), little-endian varint of 0xed. */
const ED25519_PREFIX = new Uint8Array([0xed, 0x01]);

/** Minimal base64url decode to raw bytes. */
function decodeBase64Url(b64u: string): Uint8Array {
	const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** base64url-encode raw bytes (no padding). */
function bytesToB64u(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Extract the raw 32-byte Ed25519 public key from an OKP/Ed25519 JWK. */
export function ed25519RawFromJwk(jwk: JWK): Uint8Array {
	if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) {
		throw new Error('not an Ed25519 (OKP) public JWK');
	}
	const raw = decodeBase64Url(jwk.x);
	if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
	return raw;
}

/** Encode an Ed25519 public JWK as a `publicKeyMultibase` (z-base58btc multikey). */
export function jwkToPublicKeyMultibase(jwk: JWK): string {
	const raw = ed25519RawFromJwk(jwk);
	const prefixed = new Uint8Array(ED25519_PREFIX.length + raw.length);
	prefixed.set(ED25519_PREFIX, 0);
	prefixed.set(raw, ED25519_PREFIX.length);
	return `z${base58encode(prefixed)}`;
}

/** Decode a `publicKeyMultibase` back to a raw 32-byte Ed25519 public key. */
export function publicKeyMultibaseToRaw(multibase: string): Uint8Array {
	if (!multibase.startsWith('z')) throw new Error('expected base58btc multibase (z-prefix)');
	const decoded = base58decode(multibase.slice(1));
	if (decoded[0] !== ED25519_PREFIX[0] || decoded[1] !== ED25519_PREFIX[1]) {
		throw new Error('not an Ed25519 multikey (missing 0xed01 prefix)');
	}
	const raw = decoded.slice(2);
	if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
	return raw;
}

/** Rebuild an Ed25519 public JWK from a raw 32-byte key (for Web Crypto import). */
export function rawToEd25519Jwk(raw: Uint8Array): JWK {
	return { kty: 'OKP', crv: 'Ed25519', x: bytesToB64u(raw) };
}

/** Convenience: a `publicKeyMultibase` straight to an Ed25519 public JWK. */
export function publicKeyMultibaseToJwk(multibase: string): JWK {
	return rawToEd25519Jwk(publicKeyMultibaseToRaw(multibase));
}
