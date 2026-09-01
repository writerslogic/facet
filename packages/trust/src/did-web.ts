// did:web identity + DIF Well-Known DID Configuration. The deployment DID is `did:web:<host>`, whose
// DID document is served at /.well-known/did.json with a Multikey verification method built from the
// JWKS key. A Domain Linkage Credential (a VC signed by the deployment key) binds the domain to the
// DID and is served at /.well-known/did-configuration.json per the DIF spec. Ed25519-only (matches
// the eddsa-jcs-2022 credential path). Resolution is a plain fetch, so the CLI can verify offline
// data or resolve a live host.

import type { JWK } from 'jose';
import type { SigningKey } from './keys.js';
import { jwkToPublicKeyMultibase } from './multikey.js';
import {
	VC_V2_CONTEXT,
	type VerifiableCredential,
	issueCredential,
	verifyCredential,
} from './vc.js';

/** DIF Well-Known DID Configuration v1 context. */
export const DID_CONFIGURATION_CONTEXT =
	'https://identity.foundation/.well-known/did-configuration/v1' as const;

/** Controlled Identifiers / Multikey context, used by the DID document. */
export const MULTIKEY_CONTEXT = 'https://w3id.org/security/multikey/v1' as const;

/** WHATWG URL's "ends in a number" checker — whether a URL parser would read this hostname as an IPv4
 * address. The last label decides it, so `1.2.3.4`, the bare `12345` and the hex `0x7f000001` are all
 * IPv4 to a browser even though only the first looks like one. */
function endsInANumber(hostname: string): boolean {
	const parts = hostname.split('.');
	if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
	const last = parts[parts.length - 1] ?? '';
	if (last !== '' && /^\d+$/.test(last)) return true;
	return /^0[xX][0-9a-fA-F]*$/.test(last);
}

/**
 * Why `host` cannot be a did:web method-specific identifier, or null when it can. The single
 * definition of that constraint, applied in BOTH directions: `didWebFromHost` will not mint a DID a
 * host cannot express, and `didWebToUrl` will not resolve one.
 *
 * Two normative rules, from the two specs this module already implements:
 *   - DID Core §3.1 ABNF — `idchar = ALPHA / DIGIT / "." / "-" / "_" / pct-encoded`. A host carrying
 *     anything else is not expressible as a DID at all. `_` is excluded on top of the ABNF because
 *     did:web additionally requires the identifier to "match the common name used in the SSL/TLS
 *     certificate", and no public CA issues for a label containing an underscore.
 *   - did:web — "The method specific identifier MUST match the common name used in the SSL/TLS
 *     certificate, and it MUST NOT include IP addresses." A dotted quad is therefore refused even
 *     though the ABNF would happily accept its digits and dots, and an IPv6 literal is refused twice
 *     over: `[` and `]` are not idchars either.
 *
 * `host` is the `host:port` form both directions see — the emitter percent-encodes the `:` after this
 * check, and `didWebToUrl` decodes it back before it.
 */
export function didWebHostError(host: string): string | null {
	if (!/^[a-zA-Z0-9.-]+(:\d+)?$/.test(host)) {
		return 'did:web host must be a DNS name with an optional port (DID Core idchar)';
	}
	if (endsInANumber(host.split(':')[0] as string)) {
		return 'did:web must not include IP addresses';
	}
	return null;
}

/** Build the deployment DID (`did:web:<host>`); a port in the host is percent-encoded per the spec.
 * Throws when the host is not expressible as a did:web ({@link didWebHostError}): every artifact this
 * DID goes into is signed, and a DID no verifier can resolve is worse than no DID — it is a signature
 * on a claim about an identity that does not exist. Refused at the mint, so it holds for every caller. */
export function didWebFromHost(host: string): string {
	const bad = didWebHostError(host);
	if (bad) throw new TypeError(bad);
	return `did:web:${host.replace(/:/g, '%3A')}`;
}

/** Resolve a did:web identifier to its DID-document URL (`.../.well-known/did.json` or `.../did.json`).
 * Only `:`→`%3A` (the port separator) is decoded in the host, and path segments may not contain a
 * slash or be `.`/`..`, so a crafted DID cannot inject path traversal or host confusion into the URL.
 * The host must also pass {@link didWebHostError}, which is what stops a DID naming an IP literal from
 * pointing this resolver's fetch at an arbitrary address. */
export function didWebToUrl(did: string): string {
	if (!did.startsWith('did:web:')) throw new Error('not a did:web identifier');
	const parts = did.slice('did:web:'.length).split(':');
	const host = (parts[0] as string).replace(/%3A/gi, ':');
	const badHost = didWebHostError(host);
	if (badHost) throw new Error(`invalid did:web host: ${badHost}`);
	if (parts.length === 1) return `https://${host}/.well-known/did.json`;
	const segments = parts.slice(1).map(decodeURIComponent);
	if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('/'))) {
		throw new Error('invalid did:web path segment');
	}
	// IMPORTANT: re-encode each segment — a decoded `?`, `#` or `%` would otherwise restructure the URL.
	return `https://${host}/${segments.map(encodeURIComponent).join('/')}/did.json`;
}

/** The verification-method id for the deployment key under a DID (`<did>#<kid>`). */
export function verificationMethodId(did: string, kid: string): string {
	return `${did}#${kid}`;
}

export interface DidDocument {
	'@context': string[];
	id: string;
	verificationMethod: {
		id: string;
		type: 'Multikey';
		controller: string;
		publicKeyMultibase: string;
	}[];
	assertionMethod: string[];
	authentication: string[];
}

/** Build the DID document for `did`, with a Multikey verification method from the public JWK. */
export function buildDidDocument(did: string, kid: string, publicJwk: JWK): DidDocument {
	const vmId = verificationMethodId(did, kid);
	return {
		'@context': ['https://www.w3.org/ns/did/v1', MULTIKEY_CONTEXT],
		id: did,
		verificationMethod: [
			{
				id: vmId,
				type: 'Multikey',
				controller: did,
				publicKeyMultibase: jwkToPublicKeyMultibase(publicJwk),
			},
		],
		assertionMethod: [vmId],
		authentication: [vmId],
	};
}

export interface DomainLinkageOptions {
	did: string;
	origin: string;
	key: SigningKey;
	created: string;
	/** Optional expiry (ISO). */
	validUntil?: string;
}

/** Issue a DIF Domain Linkage Credential binding `origin` to `did`, signed by the deployment key. */
export async function issueDomainLinkageCredential(
	opts: DomainLinkageOptions,
): Promise<VerifiableCredential> {
	const credential: VerifiableCredential = {
		'@context': [VC_V2_CONTEXT, DID_CONFIGURATION_CONTEXT],
		type: ['VerifiableCredential', 'DomainLinkageCredential'],
		issuer: opts.did,
		validFrom: opts.created,
		...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
		credentialSubject: { id: opts.did, origin: opts.origin },
	};
	return issueCredential(credential, opts.key, {
		verificationMethod: verificationMethodId(opts.did, opts.key.kid),
		created: opts.created,
		proofPurpose: 'assertionMethod',
	});
}

export interface DidConfiguration {
	'@context': string;
	linked_dids: VerifiableCredential[];
}

/** Wrap one or more Domain Linkage Credentials into a did-configuration.json document. */
export function buildDidConfiguration(credentials: VerifiableCredential[]): DidConfiguration {
	return { '@context': DID_CONFIGURATION_CONTEXT, linked_dids: credentials };
}

/** Extract the Multikey publicKeyMultibase for a verification method id from a DID document. */
export function publicKeyMultibaseFor(doc: DidDocument, vmId: string): string | null {
	const vm = doc.verificationMethod.find((m) => m.id === vmId);
	return vm?.publicKeyMultibase ?? null;
}

/** The three fields the code below indexes into. Deliberately NOT the full {@link DidDocument} shape:
 * a real did:web document may carry verification methods of other types, and rejecting those would
 * make this resolver stricter than the spec. */
function hasDidDocumentShape(doc: unknown): doc is DidDocument {
	const d = doc as Partial<DidDocument> | null;
	return (
		typeof d === 'object' &&
		d !== null &&
		typeof d.id === 'string' &&
		Array.isArray(d.verificationMethod) &&
		Array.isArray(d.assertionMethod)
	);
}

export interface LinkageVerification {
	valid: boolean;
	did?: string;
	origin?: string;
	reason?: string;
}

/** Verify a did-configuration against a DID document: subject binding + credential proof. Both
 * documents are untrusted JSON (fetched, or read from a file), so a malformed one is a verification
 * failure, never a throw. `now` (unix ms) additionally enforces the credential's validity window;
 * omit to leave temporal validity to the caller. */
export async function verifyDidConfiguration(
	config: DidConfiguration,
	didDoc: DidDocument,
	expectedOrigin: string,
	now?: number,
): Promise<LinkageVerification> {
	if (!hasDidDocumentShape(didDoc)) {
		return { valid: false, reason: 'malformed DID document' };
	}
	const did = didDoc.id;
	if (!Array.isArray(config?.linked_dids)) {
		return { valid: false, did, reason: 'malformed did-configuration' };
	}
	const credential = config.linked_dids.find((c) => {
		const subject = c?.credentialSubject as { id?: string; origin?: string } | undefined;
		return subject?.id === did;
	});
	if (!credential)
		return {
			valid: false,
			did,
			reason: 'no linked credential for this DID',
		};
	// DIF spec: a linkage credential is typed `DomainLinkageCredential`. Without this gate any other
	// credential the deployment key signed, carrying an `origin` next to the DID, would pass as one.
	const declaredType: unknown = credential.type;
	const types = Array.isArray(declaredType) ? declaredType : [declaredType];
	if (!types.includes('DomainLinkageCredential')) {
		return {
			valid: false,
			did,
			reason: 'credential is not a DomainLinkageCredential',
		};
	}
	const subject = credential.credentialSubject as {
		id?: string;
		origin?: string;
	};
	if (subject.origin !== expectedOrigin) {
		return {
			valid: false,
			did,
			origin: subject.origin,
			reason: 'origin mismatch',
		};
	}
	// DIF spec: the linkage credential must be issued by the DID itself, and signed by a key the DID
	// controls and authorizes for assertions. Without these, a self-signed credential naming the DID as
	// its subject would pass as a valid linkage.
	const issuer =
		typeof credential.issuer === 'string' ? credential.issuer : credential.issuer?.id;
	if (issuer !== did) {
		return {
			valid: false,
			did,
			reason: 'credential issuer does not match DID',
		};
	}
	const vmId = credential.proof?.verificationMethod ?? '';
	const vm = didDoc.verificationMethod.find((m) => m?.id === vmId);
	if (!vm) {
		return {
			valid: false,
			did,
			reason: 'verification method not found in DID document',
		};
	}
	if (typeof vm.controller !== 'string' || typeof vm.publicKeyMultibase !== 'string') {
		return {
			valid: false,
			did,
			reason: 'malformed verification method',
		};
	}
	if (vm.controller !== did) {
		return {
			valid: false,
			did,
			reason: 'verification method not controlled by DID',
		};
	}
	if (!didDoc.assertionMethod.includes(vmId)) {
		return {
			valid: false,
			did,
			reason: 'verification method not authorized for assertions',
		};
	}
	const result = await verifyCredential(credential, {
		publicKeyMultibase: vm.publicKeyMultibase,
		expectedProofPurpose: 'assertionMethod',
		now,
	});
	if (!result.valid)
		return {
			valid: false,
			did,
			origin: subject.origin,
			reason: result.reason,
		};
	return { valid: true, did, origin: subject.origin };
}

type FetchLike = (
	url: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Resolve a did:web DID document over the network (for the CLI / online checks). */
export async function resolveDidWeb(did: string, fetchImpl: FetchLike): Promise<DidDocument> {
	const url = didWebToUrl(did);
	const res = await fetchImpl(url);
	if (!res.ok) throw new Error(`did:web resolution failed (${res.status}) for ${url}`);
	const doc = await res.json();
	if (!hasDidDocumentShape(doc)) throw new Error(`did:web document is malformed at ${url}`);
	// IMPORTANT: DID Core requires the document's `id` to BE the DID resolved. Without this a
	// redirected or substituted response speaks for a DID the caller never asked about.
	if (doc.id !== did) throw new Error(`did:web document id does not match ${did}`);
	return doc;
}
