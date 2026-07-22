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

/** Build the deployment DID (`did:web:<host>`); a port in the host is percent-encoded per the spec. */
export function didWebFromHost(host: string): string {
	return `did:web:${host.replace(/:/g, '%3A')}`;
}

/** Resolve a did:web identifier to its DID-document URL (`.../.well-known/did.json` or `.../did.json`).
 * Only `:`→`%3A` (the port separator) is decoded in the host, and path segments may not contain a
 * slash or be `.`/`..`, so a crafted DID cannot inject path traversal or host confusion into the URL. */
export function didWebToUrl(did: string): string {
	if (!did.startsWith('did:web:')) throw new Error('not a did:web identifier');
	const parts = did.slice('did:web:'.length).split(':');
	const host = (parts[0] as string).replace(/%3A/gi, ':');
	if (!/^[a-zA-Z0-9.-]+(:\d+)?$/.test(host)) throw new Error('invalid did:web host');
	if (parts.length === 1) return `https://${host}/.well-known/did.json`;
	const segments = parts.slice(1).map(decodeURIComponent);
	if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('/'))) {
		throw new Error('invalid did:web path segment');
	}
	return `https://${host}/${segments.join('/')}/did.json`;
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

export interface LinkageVerification {
	valid: boolean;
	did?: string;
	origin?: string;
	reason?: string;
}

/** Verify a did-configuration against a DID document: subject binding + credential proof. */
export async function verifyDidConfiguration(
	config: DidConfiguration,
	didDoc: DidDocument,
	expectedOrigin: string,
): Promise<LinkageVerification> {
	const did = didDoc.id;
	const credential = config.linked_dids?.find((c) => {
		const subject = c.credentialSubject as { id?: string; origin?: string };
		return subject?.id === did;
	});
	if (!credential)
		return {
			valid: false,
			did,
			reason: 'no linked credential for this DID',
		};
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
	const vm = didDoc.verificationMethod.find((m) => m.id === vmId);
	if (!vm) {
		return {
			valid: false,
			did,
			reason: 'verification method not found in DID document',
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
	return (await res.json()) as DidDocument;
}
