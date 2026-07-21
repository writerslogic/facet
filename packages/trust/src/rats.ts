// RATS process-evidence attestation (EAT, RFC 9711) of the running deployment. Profiles
// draft-condrey-rats-process-evidence-claims (the `content-ref` claim + the process-evidence EAT
// profile URN) and draft-reddy-rats-key-binding (the `cnf` subject-public-key claim + `eat_nonce`
// freshness + `key-attributes`).
//
// HARDWARE ROOTING OF THE SIGNING/SUBJECT KEY IS SUPPORTED and VERIFIED, not hardcoded. Hold the key
// in an HSM / cloud-KMS-HSM (GCP Cloud KMS HSM, AWS KMS/CloudHSM, Azure Managed HSM) or a hardware
// token (YubiKey/PIV/PKCS#11) and sign via the module's API so the private key never enters the Worker
// isolate; the module emits a key-attestation credential proving the key is hardware-resident and
// non-extractable. `key-attributes.hardware` is therefore a VERIFIED, CONDITIONAL claim derived from
// such an attestation (never a hardcoded boolean): it is true ONLY when a supplied attestation verifies
// against a configured trust anchor and binds to the subject key. The native credential is verified in
// workerd (see keyattest.ts, reusing the SignedStatement / COSE_Sign1 / detached-JWS primitives that
// already run there); the X.509 chain real HSMs/YubiKeys/TPMs emit is verified by the Node CLI
// (`facet keyattest verify`, using node:crypto X509Certificate path validation). Absent or unverified
// attestation ⇒ `hardware: false`, `hardwareRootOfTrust: false` (the software-attestation default).
//
// THE ONE TRUE RESIDUAL BOUNDARY: Cloudflare does not expose an isolate runtime / measured-boot
// self-quote to Worker code, so this cannot attest a measured boot chain of the isolate ITSELF. That is
// covered from the other side by build-time SLSA provenance + a signed config/schema hash (the
// `process-evidence` claim), and we do not fabricate an isolate quote. This is distinct from — and must
// not be conflated with — hardware rooting of the KEY, which IS supported above.
//
// Proof-of-possession (PoP) IS implemented as a real challenge-response: a verifier issues a nonce; the
// issuer returns the EAT (carrying `eat_nonce`) PLUS a separate PoP signature over that nonce made with
// the `cnf` SUBJECT key; the verifier checks BOTH the EAT signature AND the PoP signature against the
// `cnf` key. The subject key may differ from the EAT signing key (the general RATS case). EATs and PoP
// signatures run under both JWS and the COSE_Sign1 wire form (both workerd-verified).

import { type JWK, calculateJwkThumbprint } from 'jose';
import { sha256, toHex, utf8 } from './bytes.js';
import { canonicalizeBytes } from './canonicalize.js';
import { signDetachedJws, verifyDetachedJws } from './jws.js';
import { type KeyAttestation, verifyKeyAttestation } from './keyattest.js';
import type { SigningKey } from './keys.js';
import {
	type SignedStatement,
	type StatementProof,
	signStatement,
	verifyStatement,
} from './statement.js';

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
	/** Key protection properties (reddy). `hardware` is derived from a VERIFIED key-attestation (see
	 * {@link IssueEvidenceOptions.keyAttestation}); with no verified attestation it is false and the key
	 * is a software key. `software` = !hardware. */
	'key-attributes': {
		hardware: boolean;
		extractable: boolean;
		software: boolean;
	};
	/** The attested process/deployment state. */
	'process-evidence': ProcessEvidence;
	/** content-ref (condrey): binds this EAT to the digest of the process-evidence. */
	'content-ref': { alg: 'sha-256'; digest: string };
	/** Reference to the hardware key-attestation this EAT's `key-attributes.hardware` was derived from,
	 * embedded so a verifier can re-verify it against its own trust anchors. Present only when a verified
	 * attestation was supplied at issue time. */
	'key-attestation'?: {
		thumbprint: string;
		deviceClass: string;
		attestation: KeyAttestation;
	};
}

export interface IssueEvidenceOptions {
	now: number;
	/** Optional verifier-supplied freshness nonce. */
	nonce?: string;
	/** The SUBJECT key whose possession is asserted (goes in `cnf`). Defaults to the EAT signing key. */
	subjectPublicJwk?: JWK;
	/** A hardware key-attestation for the subject key, to drive `key-attributes.hardware`. It is
	 * VERIFIED at issue time against `keyAttestationAnchors` and bound to the subject key's thumbprint;
	 * `hardware: true` (and an embedded `key-attestation` reference) results ONLY if that verification
	 * succeeds. Absent ⇒ `hardware: false` (the software-attestation default). */
	keyAttestation?: KeyAttestation;
	/** Configured attestor trust anchors used to verify `keyAttestation`. Without a matching anchor the
	 * attestation is rejected and `hardware` stays false. */
	keyAttestationAnchors?: JWK[];
}

/** Produce a signed process-evidence EAT for the deployment, key-bound to the `cnf` subject key
 * (`opts.subjectPublicJwk`, defaulting to `key`). */
export async function signProcessEvidence(
	evidence: ProcessEvidence,
	key: SigningKey,
	opts: IssueEvidenceOptions,
): Promise<SignedStatement<EatClaims>> {
	const digest = toHex(await sha256(canonicalizeBytes(evidence)));
	const subjectJwk = opts.subjectPublicJwk ?? key.publicJwk;
	// Derive `hardware` from a VERIFIED key-attestation bound to the subject key. Anything short of a
	// trust-anchor-verified, thumbprint-matched attestation leaves the software-attestation default.
	const hw = await deriveHardware(subjectJwk, opts);
	const claims: EatClaims = {
		eat_profile: EAT_PROCESS_PROFILE,
		iat: Math.floor(opts.now / 1000),
		...(opts.nonce ? { eat_nonce: opts.nonce } : {}),
		cnf: { jwk: subjectJwk },
		'key-attributes': {
			hardware: hw.hardware,
			extractable: false,
			software: !hw.hardware,
		},
		'process-evidence': evidence,
		'content-ref': { alg: 'sha-256', digest },
		...(hw.ref ? { 'key-attestation': hw.ref } : {}),
	};
	return signStatement(PROCESS_EVIDENCE_TYPE, claims, key, opts.now);
}

/** Verify a supplied key-attestation against the supplied anchors, bound to the subject key's RFC 7638
 * thumbprint. Returns `hardware: true` (with an embeddable reference) ONLY on full success. */
async function deriveHardware(
	subjectJwk: JWK,
	opts: IssueEvidenceOptions,
): Promise<{
	hardware: boolean;
	ref?: NonNullable<EatClaims['key-attestation']>;
}> {
	if (!opts.keyAttestation) return { hardware: false };
	const expectedThumbprint = await calculateJwkThumbprint(subjectJwk);
	const result = await verifyKeyAttestation(opts.keyAttestation, {
		trustAnchors: opts.keyAttestationAnchors ?? [],
		expectedThumbprint,
	});
	if (!result.hardware) return { hardware: false };
	return {
		hardware: true,
		ref: {
			thumbprint: expectedThumbprint,
			deviceClass: result.deviceClass ?? opts.keyAttestation.payload.deviceClass,
			attestation: opts.keyAttestation,
		},
	};
}

/** The bytes a PoP signature covers: a domain-separated binding of the challenge nonce to this EAT
 * profile. Signing these with the `cnf` subject key proves live possession of that key. */
function popMessage(nonce: string): Uint8Array {
	return utf8(`${EAT_PROCESS_PROFILE}|pop|${nonce}`);
}

/** A challenge-response proof-of-possession: a detached JWS over the nonce, made with the subject key.
 * Verification binds the PoP to the EAT's `cnf` subject key (not any key carried alongside the PoP), so
 * the subject key is not repeated here. */
export interface PopProof {
	/** The challenge nonce this PoP answers (must equal the EAT's `eat_nonce`). */
	nonce: string;
	/** Detached JWS over {@link popMessage}, signed by the `cnf` subject key. */
	jws: string;
}

/**
 * Answer a verifier's challenge: sign the process evidence into an EAT (with `eat_nonce` = `nonce` and
 * `cnf` = the subject key) AND produce a separate PoP signature over the nonce with the SUBJECT key.
 * `subjectKey` may differ from `eatKey` (the general RATS case where an attester signs the EAT for a
 * distinct subject); passing the same key for both is valid and common for a self-attesting deployment.
 */
export async function answerPopChallenge(
	evidence: ProcessEvidence,
	eatKey: SigningKey,
	subjectKey: SigningKey,
	opts: { now: number; nonce: string },
): Promise<{ eat: SignedStatement<EatClaims>; pop: PopProof }> {
	const eat = await signProcessEvidence(evidence, eatKey, {
		now: opts.now,
		nonce: opts.nonce,
		subjectPublicJwk: subjectKey.publicJwk,
	});
	const jws = await signDetachedJws(popMessage(opts.nonce), subjectKey);
	return {
		eat,
		pop: { nonce: opts.nonce, jws },
	};
}

export interface AttestationResult {
	valid: boolean;
	/** True when the EAT signature verifies and the `cnf` subject key matches the signing key. */
	keyBound: boolean;
	/** True ONLY when the EAT embeds a key-attestation that re-verifies against the supplied
	 * `trustAnchors` and binds to the `cnf` subject key. No anchors / no attestation / mismatch ⇒ false.
	 * With no attestation this is the software-attestation default (false). */
	hardwareRootOfTrust: boolean;
	evidence?: ProcessEvidence;
	reason?: string;
}

/** Re-verify an EAT's embedded key-attestation against the caller's trust anchors, bound to the `cnf`
 * subject key. Returns true ONLY when the attestation verifies AND its subject thumbprint matches the
 * `cnf` key's RFC 7638 thumbprint. Absent attestation / absent anchors / mismatch ⇒ false. This is what
 * lets a verifier decide `hardwareRootOfTrust` independently of the issuer's claim. */
async function verifyEmbeddedHardwareRoot(
	claims: EatClaims,
	trustAnchors: JWK[] | undefined,
): Promise<boolean> {
	const ref = claims['key-attestation'];
	if (!ref || !trustAnchors || trustAnchors.length === 0) return false;
	const cnfJwk = claims.cnf?.jwk as JWK | undefined;
	if (!cnfJwk) return false;
	const expectedThumbprint = await calculateJwkThumbprint(cnfJwk);
	const result = await verifyKeyAttestation(ref.attestation, {
		trustAnchors,
		expectedThumbprint,
	});
	return result.hardware;
}

/** True when the `cnf` subject key IS the key that actually signed the EAT — compared by RFC 7638
 * thumbprint of the real key material in `cnf.jwk` vs the proof's embedded public key. This is the
 * genuine key binding: the self-asserted `kid` labels are attacker-controlled and prove nothing. */
async function cnfBoundToSigner(claims: EatClaims, proof: StatementProof): Promise<boolean> {
	const cnfJwk = claims.cnf?.jwk as JWK | undefined;
	if (!cnfJwk || !proof?.publicJwk) return false;
	try {
		// cnf.jwk is attacker-controlled payload; a malformed JWK must yield keyBound:false, not throw
		// out of the never-throw verify path.
		const [cnf, signer] = await Promise.all([
			calculateJwkThumbprint(cnfJwk),
			calculateJwkThumbprint(proof.publicJwk),
		]);
		return cnf === signer;
	} catch {
		return false;
	}
}

/**
 * Verify a process-evidence EAT and produce an attestation result: the EAT signature must verify, the
 * `content-ref` digest must match the process-evidence, the `cnf` subject key must match the signing
 * key (key binding), and — when an expected nonce is supplied — `eat_nonce` must match it. When
 * `trustAnchors` are supplied, the EAT's embedded key-attestation is re-verified against them to set
 * `hardwareRootOfTrust`; absent/unverified attestation ⇒ `hardwareRootOfTrust: false` (software
 * attestation only — no hardware root of trust for the isolate itself, which Cloudflare does not
 * expose).
 */
export async function verifyProcessEvidence(
	stmt: SignedStatement<EatClaims>,
	opts: { nonce?: string; trustAnchors?: JWK[] } = {},
): Promise<AttestationResult> {
	const sig = await verifyStatement(stmt, PROCESS_EVIDENCE_TYPE);
	if (!sig.valid)
		return {
			valid: false,
			keyBound: false,
			hardwareRootOfTrust: false,
			reason: sig.reason,
		};

	const claims = stmt.payload;
	const expectedDigest = toHex(await sha256(canonicalizeBytes(claims['process-evidence'])));
	if (claims['content-ref']?.digest !== expectedDigest) {
		return {
			valid: false,
			keyBound: false,
			hardwareRootOfTrust: false,
			reason: 'content-ref digest does not match evidence',
		};
	}
	// Key binding: the cnf subject key must BE the key that signed the EAT — compared by RFC 7638
	// thumbprint of the actual key material, NOT the self-asserted `kid` labels (which a forger controls).
	const keyBound = await cnfBoundToSigner(claims, stmt.proof);
	if (!keyBound) {
		return {
			valid: false,
			keyBound: false,
			hardwareRootOfTrust: false,
			reason: 'cnf subject key is not the EAT signing key',
		};
	}
	if (opts.nonce !== undefined && claims.eat_nonce !== opts.nonce) {
		return {
			valid: false,
			keyBound,
			hardwareRootOfTrust: false,
			reason: 'eat_nonce does not match the expected nonce',
		};
	}
	const hardwareRootOfTrust = await verifyEmbeddedHardwareRoot(claims, opts.trustAnchors);
	return {
		valid: true,
		keyBound,
		hardwareRootOfTrust,
		evidence: claims['process-evidence'],
	};
}

export interface PopVerification {
	valid: boolean;
	/** The EAT verified (signature + content-ref + eat_nonce == challenge). */
	eatValid: boolean;
	/** The separate PoP signature verified against the `cnf` subject key. */
	popValid: boolean;
	/** True ONLY when the EAT embeds a key-attestation that re-verifies against the supplied
	 * `trustAnchors` and binds to the `cnf` subject key (same gate as {@link AttestationResult}). */
	hardwareRootOfTrust: boolean;
	evidence?: ProcessEvidence;
	reason?: string;
}

/**
 * Verify a challenge-response attestation: (1) the EAT must verify and its `eat_nonce` must equal the
 * verifier's `challengeNonce`; its `content-ref` must match the evidence; (2) the PoP proof's `nonce`
 * must equal the challenge; (3) the PoP JWS must verify against the EAT's `cnf` subject key over the
 * domain-separated PoP message. This closes proof-of-possession: only a holder of the private subject
 * key can produce a PoP that verifies against the `cnf` public key for a fresh, verifier-chosen nonce.
 * When `trustAnchors` are supplied, the EAT's embedded key-attestation is re-verified against them to
 * set `hardwareRootOfTrust`; absent/unverified attestation ⇒ false.
 */
export async function verifyPopChallenge(
	eat: SignedStatement<EatClaims>,
	pop: PopProof,
	challengeNonce: string,
	opts: { trustAnchors?: JWK[] } = {},
): Promise<PopVerification> {
	const sig = await verifyStatement(eat, PROCESS_EVIDENCE_TYPE);
	if (!sig.valid) {
		return {
			valid: false,
			eatValid: false,
			popValid: false,
			hardwareRootOfTrust: false,
			reason: sig.reason,
		};
	}
	const claims = eat.payload;
	const expectedDigest = toHex(await sha256(canonicalizeBytes(claims['process-evidence'])));
	if (claims['content-ref']?.digest !== expectedDigest) {
		return {
			valid: false,
			eatValid: false,
			popValid: false,
			hardwareRootOfTrust: false,
			reason: 'content-ref digest does not match evidence',
		};
	}
	if (claims.eat_nonce !== challengeNonce) {
		return {
			valid: false,
			eatValid: false,
			popValid: false,
			hardwareRootOfTrust: false,
			reason: 'eat_nonce does not match the challenge nonce',
		};
	}
	if (pop.nonce !== challengeNonce) {
		return {
			valid: false,
			eatValid: true,
			popValid: false,
			hardwareRootOfTrust: false,
			reason: 'PoP nonce does not match the challenge nonce',
		};
	}
	const cnfJwk = claims.cnf?.jwk as JWK | undefined;
	if (!cnfJwk) {
		return {
			valid: false,
			eatValid: true,
			popValid: false,
			hardwareRootOfTrust: false,
			reason: 'EAT has no cnf subject key',
		};
	}
	// The PoP MUST be verified against the EAT's cnf key, not the (possibly attacker-supplied) pop key.
	try {
		await verifyDetachedJws(pop.jws, popMessage(challengeNonce), cnfJwk);
	} catch (e) {
		return {
			valid: false,
			eatValid: true,
			popValid: false,
			hardwareRootOfTrust: false,
			reason:
				e instanceof Error
					? `PoP signature invalid: ${e.message}`
					: 'PoP signature invalid',
		};
	}
	const hardwareRootOfTrust = await verifyEmbeddedHardwareRoot(claims, opts.trustAnchors);
	return {
		valid: true,
		eatValid: true,
		popValid: true,
		hardwareRootOfTrust,
		evidence: claims['process-evidence'],
	};
}
