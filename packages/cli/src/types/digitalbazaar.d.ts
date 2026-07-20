// The digitalbazaar Data Integrity ecosystem ships no TypeScript declarations. These ambient modules
// let the Node-only cryptosuites wrapper (src/lib/cryptosuites.ts) typecheck; runtime behaviour is
// covered by real issue → derive → verify tests, not by these types. Types are intentionally loose
// (the upstream shapes are undocumented) but avoid `any` so biome's lint stays clean.

// A digitalbazaar multikey key pair: signer + export are the only members we use.
interface DbKeyPair {
	signer(): unknown;
	export(opts: {
		publicKey?: boolean;
		secretKey?: boolean;
		includeContext?: boolean;
	}): Promise<Record<string, unknown>>;
}

// A Data Integrity cryptosuite instance (opaque to us; passed straight to DataIntegrityProof).
type DbCryptosuite = Record<string, unknown>;

declare module '@digitalbazaar/bbs-2023-cryptosuite' {
	export function createSignCryptosuite(opts: {
		mandatoryPointers: string[];
	}): DbCryptosuite;
	export function createDiscloseCryptosuite(opts: {
		selectivePointers: string[];
	}): DbCryptosuite;
	export function createVerifyCryptosuite(): DbCryptosuite;
}

declare module '@digitalbazaar/ecdsa-sd-2023-cryptosuite' {
	export function createSignCryptosuite(opts: {
		mandatoryPointers: string[];
	}): DbCryptosuite;
	export function createDiscloseCryptosuite(opts: {
		selectivePointers: string[];
	}): DbCryptosuite;
	export function createVerifyCryptosuite(): DbCryptosuite;
}

declare module '@digitalbazaar/bls12-381-multikey' {
	export function generateBbsKeyPair(opts: {
		algorithm: string;
		id: string;
		controller: string;
	}): Promise<DbKeyPair>;
	export function from(doc: Record<string, unknown>): Promise<DbKeyPair>;
}

declare module '@digitalbazaar/ecdsa-multikey' {
	export function generate(opts: {
		curve: string;
		id: string;
		controller: string;
	}): Promise<DbKeyPair>;
	export function from(doc: Record<string, unknown>): Promise<DbKeyPair>;
}

declare module '@digitalbazaar/data-integrity' {
	export class DataIntegrityProof {
		constructor(opts: { signer?: unknown; cryptosuite: DbCryptosuite });
	}
}

declare module '@digitalbazaar/credentials-context' {
	export const contexts: Map<string, unknown>;
}

declare module '@digitalbazaar/data-integrity-context' {
	export const CONTEXT_URL: string;
	export const CONTEXT: unknown;
}

declare module '@digitalbazaar/multikey-context' {
	export const CONTEXT_URL: string;
	export const CONTEXT: unknown;
}

declare module 'jsonld-document-loader' {
	export class JsonLdDocumentLoader {
		addStatic(url: string, context: unknown): void;
		build(): (url: string) => Promise<{
			contextUrl: null;
			documentUrl: string;
			document: unknown;
		}>;
	}
}

declare module 'jsonld-signatures' {
	interface Jsigs {
		sign(doc: unknown, opts: unknown): Promise<Record<string, unknown>>;
		derive(doc: unknown, opts: unknown): Promise<Record<string, unknown>>;
		verify(doc: unknown, opts: unknown): Promise<{ verified: boolean; error?: unknown }>;
		purposes: { AssertionProofPurpose: new () => unknown };
	}
	const jsigs: Jsigs;
	export default jsigs;
}
