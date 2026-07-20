// Standards-conformant W3C Data Integrity selective-disclosure cryptosuites, NODE-ONLY.
//
// `ecdsa-sd-2023` and `bbs-2023` both require RDF Dataset Canonicalization (RDFC-1.0 via jsonld +
// rdf-canonize) and, for BBS, BLS12-381 pairing crypto. Those libraries import Node built-ins
// (jsonld's document loader hard-requires `node:https`), so they DO NOT load under Cloudflare Workers
// / workerd — verified by spike (`No such module "node:https"`). They are therefore exposed only here,
// in the Node CLI. The Worker keeps the Workers-native SD-JWT-style mechanism in `@facet/trust`.
//
// These wrap the digitalbazaar reference implementations (the suites' authors), with a STATIC,
// no-network document loader over the fixed VC 2.0 / Data-Integrity / Multikey contexts, so issuance
// and verification never touch the network. Real issue → deriveProof (selective reveal) → verify.

import * as bbs2023 from '@digitalbazaar/bbs-2023-cryptosuite';
import * as Bls12381Multikey from '@digitalbazaar/bls12-381-multikey';
import * as credentialsContext from '@digitalbazaar/credentials-context';
import { DataIntegrityProof } from '@digitalbazaar/data-integrity';
import * as dataIntegrityContext from '@digitalbazaar/data-integrity-context';
import * as EcdsaMultikey from '@digitalbazaar/ecdsa-multikey';
import * as ecdsaSd2023 from '@digitalbazaar/ecdsa-sd-2023-cryptosuite';
import * as multikeyContext from '@digitalbazaar/multikey-context';
import { JsonLdDocumentLoader } from 'jsonld-document-loader';
import jsigs from 'jsonld-signatures';

const { purposes } = jsigs;
const DID_V1_URL = 'https://www.w3.org/ns/did/v1';

/** A minimal, safe-mode-clean DID v1 context: only the terms these suites touch (id/type/*Method). */
const DID_V1_CONTEXT = {
	'@context': {
		'@version': 1.1,
		id: '@id',
		type: '@type',
		assertionMethod: {
			'@id': 'https://w3id.org/security#assertionMethod',
			'@type': '@id',
			'@container': '@set',
		},
		verificationMethod: {
			'@id': 'https://w3id.org/security#verificationMethod',
			'@type': '@id',
		},
	},
};

/** JSON document a document loader returns. */
type LoadedDocument = {
	contextUrl: null;
	documentUrl: string;
	document: unknown;
};
type DocumentLoader = (url: string) => Promise<LoadedDocument>;

/** A cryptosuite family we support. */
export type SdSuite = 'ecdsa-sd-2023' | 'bbs-2023';

/** Build the base static loader over the fixed, cached contexts (no network access). */
function baseLoader(): DocumentLoader {
	const jdl = new JsonLdDocumentLoader();
	for (const [url, ctx] of credentialsContext.contexts) jdl.addStatic(url, ctx);
	jdl.addStatic(dataIntegrityContext.CONTEXT_URL, dataIntegrityContext.CONTEXT);
	jdl.addStatic(multikeyContext.CONTEXT_URL, multikeyContext.CONTEXT);
	jdl.addStatic(DID_V1_URL, DID_V1_CONTEXT);
	return jdl.build() as DocumentLoader;
}

/** Extend a base loader so the issuer's controller document + verification method resolve statically. */
function loaderWithController(
	base: DocumentLoader,
	controller: string,
	vmId: string,
	publicKeyDoc: unknown,
): DocumentLoader {
	const controllerDoc = {
		'@context': [DID_V1_URL, multikeyContext.CONTEXT_URL],
		id: controller,
		assertionMethod: [publicKeyDoc],
	};
	return async (url: string) => {
		if (url === controller)
			return {
				contextUrl: null,
				documentUrl: url,
				document: controllerDoc,
			};
		if (url === vmId)
			return {
				contextUrl: null,
				documentUrl: url,
				document: publicKeyDoc,
			};
		return base(url);
	};
}

/** A generated issuer key pair plus the loader that resolves it for verification. */
export interface IssuerKey {
	suite: SdSuite;
	controller: string;
	verificationMethod: string;
	// biome-ignore lint/suspicious/noExplicitAny: the digitalbazaar key-pair types are not published.
	keyPair: any;
	publicKeyDoc: unknown;
}

/** Generate an issuer key for a suite (ecdsa-sd-2023 → P-256, bbs-2023 → BLS12-381 BBS). */
export async function generateIssuerKey(
	suite: SdSuite,
	controller = 'did:key:facet-issuer',
): Promise<IssuerKey> {
	const verificationMethod = `${controller}#${suite === 'bbs-2023' ? 'bbs' : 'k1'}`;
	const keyPair =
		suite === 'bbs-2023'
			? await Bls12381Multikey.generateBbsKeyPair({
					algorithm: 'BBS-BLS12-381-SHA-256',
					id: verificationMethod,
					controller,
				})
			: await EcdsaMultikey.generate({
					curve: 'P-256',
					id: verificationMethod,
					controller,
				});
	const publicKeyDoc = await keyPair.export({
		publicKey: true,
		includeContext: true,
	});
	return { suite, controller, verificationMethod, keyPair, publicKeyDoc };
}

/** Serialize an issuer key (INCLUDING its secret) to a portable JSON multikey document. */
export async function exportIssuerKey(key: IssuerKey): Promise<Record<string, unknown>> {
	const secret = await key.keyPair.export({
		secretKey: true,
		publicKey: true,
		includeContext: true,
	});
	return { suite: key.suite, controller: key.controller, secretKey: secret };
}

/** Reload an issuer key previously produced by {@link exportIssuerKey}. */
export async function importIssuerKey(doc: Record<string, unknown>): Promise<IssuerKey> {
	const suite = doc.suite as SdSuite;
	const secret = doc.secretKey as { id: string; controller: string };
	const keyPair =
		suite === 'bbs-2023'
			? await Bls12381Multikey.from(secret)
			: await EcdsaMultikey.from(secret);
	const publicKeyDoc = await keyPair.export({
		publicKey: true,
		includeContext: true,
	});
	return {
		suite,
		controller: secret.controller,
		verificationMethod: secret.id,
		keyPair,
		publicKeyDoc,
	};
}

function signSuiteFor(suite: SdSuite, key: IssuerKey, mandatoryPointers: string[]) {
	const factory = suite === 'bbs-2023' ? bbs2023 : ecdsaSd2023;
	return new DataIntegrityProof({
		signer: key.keyPair.signer(),
		cryptosuite: factory.createSignCryptosuite({ mandatoryPointers }),
	});
}

/**
 * Issue a base (selectively-disclosable) credential. `mandatoryPointers` are JSON pointers to claims
 * that are always revealed; every other leaf is disclosable. Returns the signed VC (the holder keeps
 * this and later derives a presentation from it).
 */
export async function issueSelective(
	suite: SdSuite,
	credential: Record<string, unknown>,
	key: IssuerKey,
	mandatoryPointers: string[] = ['/issuer'],
): Promise<Record<string, unknown>> {
	const documentLoader = loaderWithController(
		baseLoader(),
		key.controller,
		key.verificationMethod,
		key.publicKeyDoc,
	);
	return jsigs.sign(credential, {
		suite: signSuiteFor(suite, key, mandatoryPointers),
		purpose: new purposes.AssertionProofPurpose(),
		documentLoader,
	});
}

/**
 * Holder-side: derive a presentation revealing only `selectivePointers` (plus the mandatory claims the
 * issuer fixed). Undisclosed claims are cryptographically removed — a verifier cannot recover them.
 */
export async function deriveSelective(
	suite: SdSuite,
	signedCredential: Record<string, unknown>,
	key: IssuerKey,
	selectivePointers: string[],
): Promise<Record<string, unknown>> {
	const factory = suite === 'bbs-2023' ? bbs2023 : ecdsaSd2023;
	const documentLoader = loaderWithController(
		baseLoader(),
		key.controller,
		key.verificationMethod,
		key.publicKeyDoc,
	);
	return jsigs.derive(signedCredential, {
		suite: new DataIntegrityProof({
			cryptosuite: factory.createDiscloseCryptosuite({
				selectivePointers,
			}),
		}),
		purpose: new purposes.AssertionProofPurpose(),
		documentLoader,
	});
}

export interface SdVerification {
	verified: boolean;
	reason?: string;
}

/**
 * Verify a derived presentation against the issuer's public key (resolved via a static controller
 * document). Confirms the cryptosuite proof AND that the disclosed claims are the ones the proof binds.
 */
export async function verifySelective(
	suite: SdSuite,
	presentation: Record<string, unknown>,
	key: IssuerKey,
): Promise<SdVerification> {
	const factory = suite === 'bbs-2023' ? bbs2023 : ecdsaSd2023;
	const documentLoader = loaderWithController(
		baseLoader(),
		key.controller,
		key.verificationMethod,
		key.publicKeyDoc,
	);
	const result = await jsigs.verify(presentation, {
		suite: new DataIntegrityProof({
			cryptosuite: factory.createVerifyCryptosuite(),
		}),
		purpose: new purposes.AssertionProofPurpose(),
		documentLoader,
	});
	if (result.verified) return { verified: true };
	const err = result.error as { errors?: { message: string }[]; message?: string } | undefined;
	const reason =
		err?.errors?.map((e) => e.message).join('; ') ?? err?.message ?? 'verification failed';
	return { verified: false, reason };
}
