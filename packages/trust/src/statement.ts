// Generic signed statement: a typed payload plus a proof over its canonical (RFC 8785) bytes, with the
// public JWK embedded for offline verification. Reused for MMR checkpoints and SCITT signed statements.
// TWO wire forms are shipped, both workerd-verified: a detached JWS (for HTTP contexts) and a
// COSE_Sign1 (RFC 9052 — the SCITT/COSE-receipts native format). A statement carries whichever proof
// was requested; verification dispatches on the proof `type`.

import { type JWK, calculateJwkThumbprint } from 'jose';
import { bytesEqual } from './bytes.js';
import { canonicalizeBytes } from './canonicalize.js';
import { coseFromBase64url, coseToBase64url, signCoseSign1, verifyCoseSign1 } from './cose.js';
import { signDetachedJws, verifyDetachedProof } from './jws.js';
import type { SigningAlg, SigningKey } from './keys.js';

/** Detached-JWS proof (RFC 7515 App. F) over the payload's canonical bytes — the HTTP-friendly form. */
export interface JwsStatementProof {
	type: 'DetachedJWS';
	alg: SigningAlg;
	kid: string;
	jws: string;
	publicJwk: JWK;
	created: string;
}

/** COSE_Sign1 proof (RFC 9052) over the payload's canonical bytes — the SCITT-native form. The
 * COSE_Sign1 message is base64url'd so it fits a JSON envelope; the payload it commits to is the same
 * RFC 8785 canonical bytes as the JWS form, so a statement's identity is wire-format-independent. */
export interface CoseStatementProof {
	type: 'COSE_Sign1';
	alg: SigningAlg;
	kid: string;
	/** base64url(COSE_Sign1 CBOR message). */
	cose: string;
	publicJwk: JWK;
	created: string;
}

export type StatementProof = JwsStatementProof | CoseStatementProof;

export interface SignedStatement<T = unknown> {
	/** Statement type identifier, e.g. `facet-checkpoint/1` or `scitt-signed-statement/1`. */
	statement: string;
	payload: T;
	proof: StatementProof;
}

/** Wire form for a signed statement's proof: `jws` (HTTP) or `cose` (SCITT / COSE-receipts). */
export type StatementFormat = 'jws' | 'cose';

/** Sign `payload` as a typed statement (detached JWS over its canonical bytes). */
export async function signStatement<T>(
	statement: string,
	payload: T,
	key: SigningKey,
	now: number,
): Promise<SignedStatement<T>> {
	const jws = await signDetachedJws(canonicalizeBytes(payload), key);
	return {
		statement,
		payload,
		proof: {
			type: 'DetachedJWS',
			alg: key.alg,
			kid: key.kid,
			jws,
			publicJwk: key.publicJwk,
			created: new Date(now).toISOString(),
		},
	};
}

/** Sign `payload` as a typed statement with a COSE_Sign1 proof (RFC 9052) over its canonical bytes. */
export async function signStatementCose<T>(
	statement: string,
	payload: T,
	key: SigningKey,
	now: number,
): Promise<SignedStatement<T>> {
	const cose = await signCoseSign1(canonicalizeBytes(payload), key);
	return {
		statement,
		payload,
		proof: {
			type: 'COSE_Sign1',
			alg: key.alg,
			kid: key.kid,
			cose: coseToBase64url(cose),
			publicJwk: key.publicJwk,
			created: new Date(now).toISOString(),
		},
	};
}

export interface StatementVerification {
	valid: boolean;
	statement?: string;
	kid?: string;
	reason?: string;
}

/** Verify a COSE_Sign1 proof: the COSE signature must verify AND its committed payload must equal the
 * envelope payload's canonical bytes AND the protected-header kid must match the declared kid. */
async function verifyCoseProof(
	proof: CoseStatementProof,
	payload: unknown,
): Promise<{ ok: boolean; reason?: string }> {
	try {
		const { protectedHeader, payload: signed } = await verifyCoseSign1(
			coseFromBase64url(proof.cose),
			proof.publicJwk,
		);
		if (protectedHeader.kid !== proof.kid) {
			return {
				ok: false,
				reason: 'COSE protected-header kid does not match proof kid',
			};
		}
		// kid must be the RFC 7638 thumbprint of publicJwk, binding the label to the actual key.
		if (proof.kid !== (await calculateJwkThumbprint(proof.publicJwk))) {
			return {
				ok: false,
				reason: 'kid is not the RFC 7638 thumbprint of publicJwk',
			};
		}
		// The declared proof.alg must equal the SIGNED protected-header alg, else it is unauthenticated.
		if (protectedHeader.alg !== proof.alg) {
			return {
				ok: false,
				reason: 'COSE protected-header alg does not match proof alg',
			};
		}
		if (!bytesEqual(signed, canonicalizeBytes(payload))) {
			return {
				ok: false,
				reason: 'COSE payload does not match the statement payload',
			};
		}
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			reason: e instanceof Error ? e.message : 'COSE verification failed',
		};
	}
}

/** Verify a signed statement offline against its embedded public JWK, in whichever wire form it uses. */
export async function verifyStatement(
	stmt: SignedStatement,
	expectedType?: string,
): Promise<StatementVerification> {
	const { proof, payload, statement } = stmt;
	const base = { statement, kid: proof?.kid };
	if (expectedType && statement !== expectedType) {
		return {
			valid: false,
			...base,
			reason: `expected statement type ${expectedType}`,
		};
	}
	const check =
		proof?.type === 'COSE_Sign1'
			? await verifyCoseProof(proof, payload)
			: await verifyDetachedProof(proof, payload);
	return check.ok ? { valid: true, ...base } : { valid: false, ...base, reason: check.reason };
}
