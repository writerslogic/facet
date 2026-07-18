// W3C Verifiable Credentials 2.0 + Data Integrity, cryptosuite `eddsa-jcs-2022` (W3C vc-di-eddsa).
// Ed25519-only, Workers-native: the proof configuration and the unsecured document are each
// canonicalized with JCS (RFC 8785), SHA-256'd, concatenated (proofConfigHash || documentHash), and
// signed with Ed25519 over that 64-byte hashData. proofValue is base58btc multibase. Verification
// keys are Multikey (publicKeyMultibase). Web Crypto is imported via `crypto.subtle.importKey('jwk')`
// so a CryptoKey is obtained in both workerd and Node (jose's importJWK yields a Node KeyObject that
// crypto.subtle cannot use for raw verify).

import { base58decode, base58encode } from './base58.js';
import { canonicalizeBytes } from './canonicalize.js';
import { type SigningKey, requireCryptoKey } from './keys.js';
import { ed25519RawFromJwk, publicKeyMultibaseToJwk, rawToEd25519Jwk } from './multikey.js';

/** The W3C VC 2.0 base context. */
export const VC_V2_CONTEXT = 'https://www.w3.org/ns/credentials/v2' as const;

/** The Data Integrity cryptosuite this module implements. */
export const CRYPTOSUITE = 'eddsa-jcs-2022' as const;

export interface DataIntegrityProof {
	type: 'DataIntegrityProof';
	cryptosuite: typeof CRYPTOSUITE;
	created: string;
	verificationMethod: string;
	proofPurpose: string;
	proofValue: string;
}

/** A minimal Verifiable Credential shape (open to extra fields). */
export interface VerifiableCredential {
	'@context': (string | Record<string, unknown>)[];
	type: string[];
	issuer: string | { id: string };
	validFrom?: string;
	validUntil?: string;
	credentialSubject: Record<string, unknown>;
	proof?: DataIntegrityProof;
	[key: string]: unknown;
}

export interface IssueOptions {
	verificationMethod: string;
	created: string;
	proofPurpose?: string;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** proofConfigHash || transformedDocumentHash — the 64-byte hashData eddsa-jcs-2022 signs. */
async function hashData(
	unsecured: Record<string, unknown>,
	proofConfig: Record<string, unknown>,
): Promise<Uint8Array> {
	const proofConfigHash = await sha256(canonicalizeBytes(proofConfig));
	const documentHash = await sha256(canonicalizeBytes(unsecured));
	const out = new Uint8Array(64);
	out.set(proofConfigHash, 0);
	out.set(documentHash, 32);
	return out;
}

/** Build the proof configuration (proof options, no proofValue) that gets canonicalized + hashed. */
function proofConfig(
	credential: VerifiableCredential,
	opts: IssueOptions,
): Record<string, unknown> {
	return {
		'@context': credential['@context'],
		type: 'DataIntegrityProof',
		cryptosuite: CRYPTOSUITE,
		created: opts.created,
		verificationMethod: opts.verificationMethod,
		proofPurpose: opts.proofPurpose ?? 'assertionMethod',
	};
}

/** The key/keydata types Web Crypto expects, derived from the runtime so we don't depend on the
 * `CryptoKey`/`JsonWebKey` global type names being exported (they are not, under @types/node). */
type ImportedKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** Import an Ed25519 public JWK as a Web Crypto verify key (CryptoKey under both workerd and Node). */
async function importEd25519Verify(jwk: {
	kty: string;
	crv?: string;
	x?: string;
}): Promise<ImportedKey> {
	// 'jwk' import; cast through `never` to avoid naming the JsonWebKey global type.
	return crypto.subtle.importKey('jwk', jwk as never, { name: 'Ed25519' }, false, ['verify']);
}

/** Issue a credential: attach an eddsa-jcs-2022 Data Integrity proof signed by `key` (Ed25519 only). */
export async function issueCredential(
	credential: VerifiableCredential,
	key: SigningKey,
	opts: IssueOptions,
): Promise<VerifiableCredential> {
	if (key.alg !== 'EdDSA') {
		throw new Error('eddsa-jcs-2022 requires an Ed25519 deployment key (key.alg is not EdDSA)');
	}
	const { proof: Drop, ...unsecured } = credential;
	const config = proofConfig(credential, opts);
	const data = await hashData(unsecured, config);
	const privateKey = requireCryptoKey(key.privateKey);
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data),
	);
	const proof: DataIntegrityProof = {
		type: 'DataIntegrityProof',
		cryptosuite: CRYPTOSUITE,
		created: opts.created,
		verificationMethod: opts.verificationMethod,
		proofPurpose: opts.proofPurpose ?? 'assertionMethod',
		proofValue: `z${base58encode(signature)}`,
	};
	return { ...unsecured, proof } as VerifiableCredential;
}

export interface VerifyOptions {
	/** The expected public key, as an Ed25519 JWK or a Multikey publicKeyMultibase. */
	publicJwk?: { kty: string; crv?: string; x?: string };
	publicKeyMultibase?: string;
}

export interface CredentialVerification {
	valid: boolean;
	issuer?: string;
	verificationMethod?: string;
	reason?: string;
}

/** Verify an eddsa-jcs-2022 Data Integrity proof against a supplied public key. */
export async function verifyCredential(
	credential: VerifiableCredential,
	opts: VerifyOptions,
): Promise<CredentialVerification> {
	const proof = credential.proof;
	const issuer =
		typeof credential.issuer === 'string' ? credential.issuer : credential.issuer?.id;
	const fail = (reason: string): CredentialVerification => ({
		valid: false,
		issuer,
		verificationMethod: proof?.verificationMethod,
		reason,
	});
	if (!proof) return fail('missing proof');
	if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== CRYPTOSUITE) {
		return fail(`unsupported proof (${proof.type}/${proof.cryptosuite})`);
	}
	if (!proof.proofValue?.startsWith('z')) return fail('proofValue is not base58btc multibase');

	let jwk: { kty: string; crv?: string; x?: string };
	try {
		if (opts.publicKeyMultibase) jwk = publicKeyMultibaseToJwk(opts.publicKeyMultibase);
		else if (opts.publicJwk) jwk = rawToEd25519Jwk(ed25519RawFromJwk(opts.publicJwk));
		else return fail('no verification key supplied');
	} catch (e) {
		return fail(e instanceof Error ? e.message : 'invalid verification key');
	}

	const { proof: P, ...unsecured } = credential;
	const config: Record<string, unknown> = {
		'@context': credential['@context'],
		type: proof.type,
		cryptosuite: proof.cryptosuite,
		created: proof.created,
		verificationMethod: proof.verificationMethod,
		proofPurpose: proof.proofPurpose,
	};
	try {
		const data = await hashData(unsecured, config);
		const signature = base58decode(proof.proofValue.slice(1));
		const key = await importEd25519Verify(jwk);
		const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data);
		return ok
			? {
					valid: true,
					issuer,
					verificationMethod: proof.verificationMethod,
				}
			: fail('signature did not verify');
	} catch (e) {
		return fail(e instanceof Error ? e.message : 'verification error');
	}
}
