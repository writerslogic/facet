// Generic signed statement: a typed payload plus a detached-JWS proof over its canonical (RFC 8785)
// bytes, with the public JWK embedded for offline verification. Reused for MMR checkpoints and SCITT
// signed statements. The canonical SCITT serialization is COSE_Sign1; a COSE variant is format-ready
// but gated on a workerd-verified COSE library (see the trust README), so we ship the JWS form here.

import type { JWK } from 'jose';
import { canonicalizeBytes } from './canonicalize.js';
import { signDetachedJws, verifyDetachedProof } from './jws.js';
import type { SigningAlg, SigningKey } from './keys.js';

export interface StatementProof {
	type: 'DetachedJWS';
	alg: SigningAlg;
	kid: string;
	jws: string;
	publicJwk: JWK;
	created: string;
}

export interface SignedStatement<T = unknown> {
	/** Statement type identifier, e.g. `facet-checkpoint/1` or `scitt-signed-statement/1`. */
	statement: string;
	payload: T;
	proof: StatementProof;
}

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

export interface StatementVerification {
	valid: boolean;
	statement?: string;
	kid?: string;
	reason?: string;
}

/** Verify a signed statement offline against its embedded public JWK. */
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
	const check = await verifyDetachedProof(proof, payload);
	return check.ok ? { valid: true, ...base } : { valid: false, ...base, reason: check.reason };
}
