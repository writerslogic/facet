// Hardware key-attestation (workerd-native). A trusted ATTESTOR asserts, in a SignedStatement, that a
// SUBJECT public key was generated in and is non-extractable from a hardware device (HSM / TPM / secure
// element). This is the credential a cloud-KMS-HSM or hardware token emits (here as a signed statement,
// verified with the existing COSE_Sign1 / detached-JWS primitives that already run in workerd); the Node
// CLI verifies the X.509 form real HSMs/YubiKeys/TPMs emit (see @writerslogic/facet-cli `keyattest`).
//
// The subject key is identified by its RFC 7638 JWK thumbprint so the attestation binds to a specific
// key, not merely to a device. `hardware: true` is a VERIFIED, CONDITIONAL claim: it is reachable ONLY
// when (1) the attestor signature verifies, AND (2) the signer is one of the caller-configured trust
// anchors (vendor/org attestor roots), AND (3) the attested subject thumbprint matches the key we
// expect. Any failure ⇒ `hardware: false` with a reason. There is NO code path that yields
// `hardware: true` without a trust-anchor-verified attestation.

import { type JWK, calculateJwkThumbprint } from 'jose';
import type { SigningKey } from './keys.js';
import { type SignedStatement, signStatement, verifyStatement } from './statement.js';

/** Statement type for a Facet hardware key-attestation. */
export const KEY_ATTESTATION_TYPE = 'facet-key-attestation/1' as const;

/** The device class a key is attested to be resident in. Open string to allow vendor-specific values. */
export type DeviceClass = 'hsm' | 'tpm' | 'secure-element' | (string & {});

/** Hardware properties the attestor asserts about the subject key's device. */
export interface DeviceProps {
	/** The class of hardware the key is resident in. */
	deviceClass: DeviceClass;
	/** FIPS 140-2/3 security level of the device, when the attestor asserts one. */
	fipsLevel?: number;
	/** The device/module vendor (e.g. 'Google Cloud KMS', 'YubiKey', 'AWS CloudHSM'). */
	vendor: string;
}

/** The attested claim set: which subject key, what device, and the non-extractability assertion. */
export interface KeyAttestationClaims {
	/** RFC 7638 JWK thumbprint of the SUBJECT public key this attestation is about. */
	subjectThumbprint: string;
	/** The subject public JWK, echoed so a verifier can recompute the thumbprint offline. */
	subjectPublicJwk: JWK;
	/** The class of hardware the subject key is resident in. */
	deviceClass: DeviceClass;
	/** FIPS security level, when asserted. */
	fipsLevel?: number;
	/** The attestor asserts the private key is non-extractable from the device. Always false-as-in-not-
	 * extractable; carried explicitly so the claim is self-describing on the wire. */
	extractable: false;
	/** The device/module vendor. */
	vendor: string;
	/** Issued-at, seconds since epoch. */
	iat: number;
}

/** A signed hardware key-attestation: an attestor's SignedStatement over {@link KeyAttestationClaims}. */
export type KeyAttestation = SignedStatement<KeyAttestationClaims>;

/**
 * Sign a hardware key-attestation: the ATTESTOR (`attestorKey`) asserts that `subjectPublicJwk` is a
 * hardware-resident, non-extractable key with the given device properties. The subject thumbprint is
 * computed here (RFC 7638) so it always matches the echoed subject key. This models the credential a
 * KMS-HSM / hardware token emits; a real device produces it inside the module.
 */
export async function signKeyAttestation(
	subjectPublicJwk: JWK,
	deviceProps: DeviceProps,
	attestorKey: SigningKey,
	now: number,
): Promise<KeyAttestation> {
	const subjectThumbprint = await calculateJwkThumbprint(subjectPublicJwk);
	const claims: KeyAttestationClaims = {
		subjectThumbprint,
		subjectPublicJwk,
		deviceClass: deviceProps.deviceClass,
		...(deviceProps.fipsLevel !== undefined ? { fipsLevel: deviceProps.fipsLevel } : {}),
		extractable: false,
		vendor: deviceProps.vendor,
		iat: Math.floor(now / 1000),
	};
	return signStatement(KEY_ATTESTATION_TYPE, claims, attestorKey, now);
}

/** Options for {@link verifyKeyAttestation}. */
export interface VerifyKeyAttestationOptions {
	/** Configured attestor public JWKs (vendor/org roots). The attestation's signer MUST be one of these
	 * for `hardware` to be true. An empty or absent set ⇒ no anchor can match ⇒ `hardware: false`. */
	trustAnchors: JWK[];
	/** Verification time, ms since epoch (reserved for future validity windows; kept for a stable API). */
	now: number;
	/** The subject-key thumbprint the caller expects this attestation to be about. When supplied it MUST
	 * match the attested subject thumbprint, else `hardware: false`. */
	expectedThumbprint?: string;
}

/** The verdict of verifying a key-attestation. `hardware` is the security-critical output. */
export interface KeyAttestationVerification {
	/** The attestor signature verified AND the statement is well-formed. */
	valid: boolean;
	/** TRUE only when: signature valid AND signer ∈ trustAnchors AND (subject thumbprint self-consistent)
	 * AND (expectedThumbprint, if given, matches). This is the ONLY thing that makes a key hardware. */
	hardware: boolean;
	deviceClass?: DeviceClass;
	fipsLevel?: number;
	/** The attested subject-key thumbprint, when the signature verified. */
	subjectThumbprint?: string;
	/** The vendor, when the signature verified. */
	vendor?: string;
	/** Why `hardware` is false (or the attestation is invalid). Absent on full success. */
	reason?: string;
}

/**
 * Verify a hardware key-attestation and decide `hardware`. The gating, in order:
 *   1. The attestor signature over the statement must verify (delegated to `verifyStatement`).
 *   2. The attested `subjectThumbprint` must equal the RFC 7638 thumbprint of the echoed subject JWK
 *      (self-consistency: the attestation cannot lie about which key it is for).
 *   3. If `expectedThumbprint` is supplied, it must equal the attested subject thumbprint.
 *   4. The signer (the statement proof's public JWK) must be one of the configured `trustAnchors`,
 *      matched by RFC 7638 thumbprint. NO anchor match ⇒ `hardware: false`.
 * `hardware` is true only when ALL of the above hold. Every early return sets `hardware: false`.
 */
export async function verifyKeyAttestation(
	attestation: KeyAttestation,
	opts: VerifyKeyAttestationOptions,
): Promise<KeyAttestationVerification> {
	const sig = await verifyStatement(attestation, KEY_ATTESTATION_TYPE);
	if (!sig.valid) {
		return {
			valid: false,
			hardware: false,
			reason: sig.reason ?? 'attestation signature invalid',
		};
	}

	const claims = attestation.payload;

	// (2) The attestation must not lie about which key it is for: the declared thumbprint must be the
	// real RFC 7638 thumbprint of the echoed subject key.
	const recomputed = await calculateJwkThumbprint(claims.subjectPublicJwk);
	if (recomputed !== claims.subjectThumbprint) {
		return {
			valid: true,
			hardware: false,
			subjectThumbprint: claims.subjectThumbprint,
			reason: 'subject thumbprint does not match the attested subject key',
		};
	}

	// (3) Bind to the key the caller actually cares about, when they say which.
	if (
		opts.expectedThumbprint !== undefined &&
		opts.expectedThumbprint !== claims.subjectThumbprint
	) {
		return {
			valid: true,
			hardware: false,
			subjectThumbprint: claims.subjectThumbprint,
			vendor: claims.vendor,
			reason: 'attested subject thumbprint does not match the expected key',
		};
	}

	// (4) THE security-critical gate: the signer must be a configured trust anchor. This is the only way
	// `hardware` becomes true. An empty/absent anchor set can never match ⇒ hardware stays false.
	const signerThumbprint = await signerThumbprintOf(attestation);
	const anchorThumbprints = await Promise.all(
		opts.trustAnchors.map((a) => calculateJwkThumbprint(a)),
	);
	const anchored = signerThumbprint !== undefined && anchorThumbprints.includes(signerThumbprint);
	if (!anchored) {
		return {
			valid: true,
			hardware: false,
			subjectThumbprint: claims.subjectThumbprint,
			vendor: claims.vendor,
			reason: 'attestor is not a configured trust anchor',
		};
	}

	return {
		valid: true,
		hardware: true,
		deviceClass: claims.deviceClass,
		...(claims.fipsLevel !== undefined ? { fipsLevel: claims.fipsLevel } : {}),
		subjectThumbprint: claims.subjectThumbprint,
		vendor: claims.vendor,
	};
}

/** The RFC 7638 thumbprint of the key that signed the attestation (from the proof's embedded JWK). The
 * proof JWK is what `verifyStatement` has already verified the signature against, so it is the true
 * signer. Returns undefined if the proof carries no public JWK. */
async function signerThumbprintOf(attestation: KeyAttestation): Promise<string | undefined> {
	const jwk = attestation.proof?.publicJwk;
	if (!jwk) return undefined;
	return calculateJwkThumbprint(jwk);
}
