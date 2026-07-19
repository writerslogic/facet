// Detached JWS (RFC 7515, Appendix F): the signature travels separately from the payload (e.g. in an
// HTTP header) while the body carries the raw bytes. We build a compact JWS, then blank the middle
// (payload) segment for transmission; verification re-attaches the caller-supplied payload. Uses
// `jose` end-to-end so it runs in workerd.

import { CompactSign, type JWK, base64url, compactVerify } from 'jose';
import { canonicalizeBytes } from './canonicalize.js';
import { type SigningKey, importPublicJwk } from './keys.js';

/** Sign `payload` and return a compact *detached* JWS (`<protected>..<signature>`). */
export async function signDetachedJws(payload: Uint8Array, key: SigningKey): Promise<string> {
	const jws = await new CompactSign(payload)
		.setProtectedHeader({ alg: key.alg, kid: key.kid })
		.sign(key.privateKey);
	const [protectedHeader, , signature] = jws.split('.');
	return `${protectedHeader}..${signature}`;
}

/** Result of verifying a detached JWS: the protected header, on success. */
export interface DetachedJwsVerification {
	protectedHeader: Record<string, unknown>;
}

/** Re-attach `payload` to a detached JWS and verify it against `publicJwk`. Throws on failure. */
export async function verifyDetachedJws(
	detached: string,
	payload: Uint8Array,
	publicJwk: JWK,
): Promise<DetachedJwsVerification> {
	const parts = detached.split('.');
	if (parts.length !== 3 || parts[1] !== '') {
		throw new Error('malformed detached JWS (expected `<protected>..<signature>`)');
	}
	const reattached = `${parts[0]}.${base64url.encode(payload)}.${parts[2]}`;
	const { key, alg } = await importPublicJwk(publicJwk);
	const { protectedHeader } = await compactVerify(reattached, key, {
		algorithms: [alg],
	});
	return { protectedHeader };
}

/** A detached-JWS proof embedded in a signed envelope (signed-export, statement, receipt, …). */
export interface DetachedProof {
	type: string;
	jws: string;
	kid: string;
	publicJwk: JWK;
}

/** Outcome of {@link verifyDetachedProof}. */
export interface DetachedProofCheck {
	ok: boolean;
	reason?: string;
}

/** Verify a detached-JWS proof over the canonical (RFC 8785) bytes of `payload`, checking that the
 * protected-header `kid` matches the proof's declared `kid`. Shared by every signed envelope so the
 * security-critical verification kernel lives in exactly one place. Never throws. */
export async function verifyDetachedProof(
	proof: DetachedProof | undefined,
	payload: unknown,
): Promise<DetachedProofCheck> {
	if (proof?.type !== 'DetachedJWS') return { ok: false, reason: 'unsupported proof type' };
	try {
		const { protectedHeader } = await verifyDetachedJws(
			proof.jws,
			canonicalizeBytes(payload),
			proof.publicJwk,
		);
		if (protectedHeader.kid !== proof.kid) {
			return {
				ok: false,
				reason: 'protected-header kid does not match proof kid',
			};
		}
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			reason: e instanceof Error ? e.message : 'verification failed',
		};
	}
}
