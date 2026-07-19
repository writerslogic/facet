// RATS process-evidence attestation (EAT, RFC 9711) of the running deployment. Profiles
// draft-condrey-rats-process-evidence-claims (the `content-ref` claim + the process-evidence EAT
// profile URN) and draft-reddy-rats-key-binding (the `cnf` subject-public-key claim + `eat_nonce`
// freshness + `key-attributes`). SOFTWARE ATTESTATION ONLY: the signing key is a Worker secret, not a
// hardware-backed Attestation Key, and there is no hardware root of trust — this attests the
// deployment's build/config/privacy state, not a measured boot chain. Proof-of-possession of the
// subject key is protocol-level and out of scope here. The EAT is a JWS statement (COSE_Sign1 is
// format-ready, gated on a workerd-verified COSE lib — see the trust README).

import { sha256, toHex } from './bytes.js';
import { canonicalizeBytes } from './canonicalize.js';
import type { SigningKey } from './keys.js';
import { type SignedStatement, signStatement, verifyStatement } from './statement.js';

/** EAT profile URN for creation/process evidence (draft-condrey). */
export const EAT_PROCESS_PROFILE = 'urn:ietf:params:rats:eat:profile:process-evidence:1.0' as const;

/** Statement type for a Facet process-evidence EAT. */
export const PROCESS_EVIDENCE_TYPE = 'rats-process-evidence/1' as const;

/** The attested deployment state (never anything about a visitor). */
export interface ProcessEvidence {
	buildId: string;
	commit: string;
	schemaHash: string;
	wranglerHash: string;
	/** The enabled privacy transforms, as stable labels. */
	privacyTransforms: string[];
}

/** EAT claim set: standard EAT + condrey content-ref + reddy cnf/key-attributes. */
export interface EatClaims {
	eat_profile: typeof EAT_PROCESS_PROFILE;
	/** Issued-at, seconds since epoch. */
	iat: number;
	/** Verifier-supplied freshness nonce (reddy), when present. */
	eat_nonce?: string;
	/** Subject public key (reddy / RFC 7800): the key whose possession is asserted. */
	cnf: { jwk: unknown };
	/** Key protection properties (reddy). Software key: not hardware-backed, non-extractable import. */
	'key-attributes': {
		hardware: boolean;
		extractable: boolean;
		software: boolean;
	};
	/** The attested process/deployment state. */
	'process-evidence': ProcessEvidence;
	/** content-ref (condrey): binds this EAT to the digest of the process-evidence. */
	'content-ref': { alg: 'sha-256'; digest: string };
}

export interface IssueEvidenceOptions {
	now: number;
	/** Optional verifier-supplied freshness nonce. */
	nonce?: string;
}

/** Produce a signed process-evidence EAT for the deployment, key-bound to `key`. */
export async function signProcessEvidence(
	evidence: ProcessEvidence,
	key: SigningKey,
	opts: IssueEvidenceOptions,
): Promise<SignedStatement<EatClaims>> {
	const digest = toHex(await sha256(canonicalizeBytes(evidence)));
	const claims: EatClaims = {
		eat_profile: EAT_PROCESS_PROFILE,
		iat: Math.floor(opts.now / 1000),
		...(opts.nonce ? { eat_nonce: opts.nonce } : {}),
		cnf: { jwk: key.publicJwk },
		'key-attributes': {
			hardware: false,
			extractable: false,
			software: true,
		},
		'process-evidence': evidence,
		'content-ref': { alg: 'sha-256', digest },
	};
	return signStatement(PROCESS_EVIDENCE_TYPE, claims, key, opts.now);
}

export interface AttestationResult {
	valid: boolean;
	/** True when the EAT signature verifies and the `cnf` subject key matches the signing key. */
	keyBound: boolean;
	evidence?: ProcessEvidence;
	reason?: string;
}

/**
 * Verify a process-evidence EAT and produce an attestation result: the EAT signature must verify, the
 * `content-ref` digest must match the process-evidence, the `cnf` subject key must match the signing
 * key (key binding), and — when an expected nonce is supplied — `eat_nonce` must match it. Software
 * attestation only: this does not establish a hardware root of trust.
 */
export async function verifyProcessEvidence(
	stmt: SignedStatement<EatClaims>,
	opts: { nonce?: string } = {},
): Promise<AttestationResult> {
	const sig = await verifyStatement(stmt, PROCESS_EVIDENCE_TYPE);
	if (!sig.valid) return { valid: false, keyBound: false, reason: sig.reason };

	const claims = stmt.payload;
	const expectedDigest = toHex(await sha256(canonicalizeBytes(claims['process-evidence'])));
	if (claims['content-ref']?.digest !== expectedDigest) {
		return {
			valid: false,
			keyBound: false,
			reason: 'content-ref digest does not match evidence',
		};
	}
	// Key binding: the cnf subject key must be the key that signed the EAT.
	const cnfKid = (claims.cnf?.jwk as { kid?: string } | undefined)?.kid;
	const keyBound = cnfKid !== undefined && cnfKid === stmt.proof.kid;
	if (!keyBound) {
		return {
			valid: false,
			keyBound: false,
			reason: 'cnf subject key is not bound to the signing key',
		};
	}
	if (opts.nonce !== undefined && claims.eat_nonce !== opts.nonce) {
		return {
			valid: false,
			keyBound,
			reason: 'eat_nonce does not match the expected nonce',
		};
	}
	return { valid: true, keyBound, evidence: claims['process-evidence'] };
}
