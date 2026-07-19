// Selective disclosure, Workers-native. The W3C ecdsa-sd-2023 and bbs-2023 cryptosuites are NOT used
// here: ecdsa-sd-2023 depends on RDF Dataset Canonicalization (jsonld / rdf-canonize), which does not
// run under workerd, and bbs-2023 needs pairing-friendly-curve crypto that Web Crypto does not
// provide. Instead we ship an SD-JWT-style mechanism over the credential's claims: each disclosable
// claim becomes a salted `[salt, name, value]` disclosure whose SHA-256 digest is embedded in the
// signed credential (`credentialSubject._sd`). The credential is signed with eddsa-jcs-2022, so the
// set of digests is integrity-protected; a holder reveals any subset of disclosures, and a verifier
// (1) checks the credential proof and (2) confirms each revealed disclosure's digest is in `_sd`.
// Undisclosed claims never leave the issuer as anything but an opaque digest. This binds only DATASET
// / DEPLOYMENT claims — never a person.

import { bytesToBase64url, sha256 } from './bytes.js';
import { canonicalizeBytes } from './canonicalize.js';
import type { SigningKey } from './keys.js';
import {
	type CredentialVerification,
	type VerifiableCredential,
	type VerifyOptions,
	issueCredential,
	verifyCredential,
} from './vc.js';

/** A single selective-disclosure element: a salted claim whose digest is embedded in the credential. */
export interface Disclosure {
	salt: string;
	name: string;
	value: unknown;
}

/** Digest of a disclosure: base64url(SHA-256(JCS([salt, name, value]))). */
async function disclosureDigest(d: Disclosure): Promise<string> {
	return bytesToBase64url(await sha256(canonicalizeBytes([d.salt, d.name, d.value])));
}

/** A fresh 128-bit salt as base64url. */
function makeSalt(): string {
	return bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** An issued selectively-disclosable credential: the signed credential plus all disclosures. */
export interface SelectiveCredential {
	credential: VerifiableCredential;
	disclosures: Disclosure[];
}

export interface IssueSdOptions {
	verificationMethod: string;
	created: string;
	proofPurpose?: string;
}

/**
 * Issue a selectively-disclosable credential. `mandatory` claims are embedded in
 * `credentialSubject` in the clear; `selective` claims are replaced by digests in
 * `credentialSubject._sd` and returned as disclosures. Ed25519 only (eddsa-jcs-2022).
 */
export async function issueSelectiveCredential(
	base: VerifiableCredential,
	mandatory: Record<string, unknown>,
	selective: Record<string, unknown>,
	key: SigningKey,
	opts: IssueSdOptions,
): Promise<SelectiveCredential> {
	const disclosures: Disclosure[] = Object.entries(selective).map(([name, value]) => ({
		salt: makeSalt(),
		name,
		value,
	}));
	const sd = (await Promise.all(disclosures.map(disclosureDigest))).sort();
	const credential: VerifiableCredential = {
		...base,
		// biome-ignore lint/style/useNamingConvention: `_sd` is the SD-JWT spec-defined digest array name.
		credentialSubject: { ...base.credentialSubject, ...mandatory, _sd: sd },
	};
	const signed = await issueCredential(credential, key, opts);
	return { credential: signed, disclosures };
}

/** Derive a presentation revealing only `revealNames`; other disclosures are dropped. */
export function deriveDisclosure(
	issued: SelectiveCredential,
	revealNames: string[],
): SelectiveCredential {
	const set = new Set(revealNames);
	return {
		credential: issued.credential,
		disclosures: issued.disclosures.filter((d) => set.has(d.name)),
	};
}

export interface SelectiveVerification extends CredentialVerification {
	/** The revealed claim name→value pairs whose digests are present in the signed `_sd` set. */
	revealed: Record<string, unknown>;
}

/**
 * Verify a selectively-disclosed credential: the credential's eddsa-jcs-2022 proof must verify, and
 * every provided disclosure's digest must appear in the signed `credentialSubject._sd` set. Returns
 * the revealed claims (only those actually disclosed and digest-matched).
 */
export async function verifySelectiveCredential(
	presentation: SelectiveCredential,
	opts: VerifyOptions,
): Promise<SelectiveVerification> {
	const base = await verifyCredential(presentation.credential, opts);
	if (!base.valid) return { ...base, revealed: {} };

	const subject = presentation.credential.credentialSubject as {
		// biome-ignore lint/style/useNamingConvention: `_sd` is the SD-JWT spec-defined digest array name.
		_sd?: unknown;
	};
	const sd = Array.isArray(subject._sd) ? new Set(subject._sd as string[]) : new Set<string>();
	const revealed: Record<string, unknown> = {};
	for (const d of presentation.disclosures) {
		const digest = await disclosureDigest(d);
		if (!sd.has(digest)) {
			return {
				valid: false,
				revealed: {},
				reason: `disclosure "${d.name}" digest not in _sd`,
			};
		}
		revealed[d.name] = d.value;
	}
	return { ...base, revealed };
}
