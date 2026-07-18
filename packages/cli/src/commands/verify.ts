// `facet verify <what> [file] [flags]`: offline verifiers for Facet's signed artifacts, all backed
// by @facet/trust (never re-implemented here):
//   export <file>                              — a signed-export envelope (embedded key, fully offline)
//   credential <file> --key <z…> | --jwk <f>   — a VC's eddsa-jcs-2022 Data Integrity proof
//   did-configuration <file> --did-doc <f> [--origin <o>]  — a DIF domain-linkage against a DID doc
// Later phases add `receipt` (MMR inclusion) and `attestation` (RATS) subcommands.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
	type DidConfiguration,
	type DidDocument,
	type ScittReceiptPayload,
	type SignedExport,
	type SignedStatement,
	type VerifiableCredential,
	verifyCredential,
	verifyDidConfiguration,
	verifyScittReceipt,
	verifySignedExport,
} from '@facet/trust';
import pc from 'picocolors';
import { printError } from '../util.js';

const USAGE = `Usage: facet verify <target> [file] [flags]

Targets:
  export <file>                                  Verify a signed stats export envelope (offline).
  credential <file> (--key <z…> | --jwk <file>)  Verify a VC's eddsa-jcs-2022 proof.
  did-configuration <file> --did-doc <file> [--origin <origin>]
                                                 Verify a DIF domain-linkage against a DID document.
  receipt <file>                                 Verify a SCITT receipt (signature + MMR inclusion).
`;

/** Read + parse a JSON file, returning null (and printing) on any error. */
async function readJson(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (err) {
		printError(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

function ok(msg: string): void {
	process.stdout.write(`${pc.green('✓')} ${msg}\n`);
}

async function verifyExport(path: string): Promise<number> {
	const doc = await readJson(path);
	if (doc === null) return 1;
	const result = await verifySignedExport(doc as SignedExport);
	if (result.valid) {
		ok(`valid signed export (alg=${result.alg}, kid=${result.kid})`);
		if (result.jwksUrl) {
			process.stdout.write(`  key: ${result.jwksUrl}\n`);
			process.stdout.write(
				`  ${pc.dim('note: for full trust, confirm this kid appears in the deployment JWKS above.')}\n`,
			);
		}
		return 0;
	}
	printError(`✗ invalid signed export: ${result.reason ?? 'signature did not verify'}`);
	return 1;
}

async function verifyCredentialCmd(file: string, flags: Record<string, string>): Promise<number> {
	const doc = await readJson(file);
	if (doc === null) return 1;
	const publicKeyMultibase = flags.key;
	if (!publicKeyMultibase && flags.jwk) {
		const jwk = await readJson(flags.jwk);
		if (jwk === null) return 1;
		const result = await verifyCredential(doc as VerifiableCredential, {
			publicJwk: jwk as { kty: string; crv?: string; x?: string },
		});
		return report(result);
	}
	if (!publicKeyMultibase) {
		printError('provide the verification key with --key <publicKeyMultibase> or --jwk <file>');
		return 1;
	}
	const result = await verifyCredential(doc as VerifiableCredential, {
		publicKeyMultibase,
	});
	return report(result);
}

function report(result: {
	valid: boolean;
	issuer?: string;
	reason?: string;
}): number {
	if (result.valid) {
		ok(`valid credential (issuer=${result.issuer ?? 'unknown'})`);
		return 0;
	}
	printError(`✗ invalid credential: ${result.reason ?? 'signature did not verify'}`);
	return 1;
}

async function verifyDidConfigurationCmd(
	file: string,
	flags: Record<string, string>,
): Promise<number> {
	if (!flags['did-doc']) {
		printError('provide the DID document with --did-doc <file>');
		return 1;
	}
	const config = await readJson(file);
	const didDoc = await readJson(flags['did-doc']);
	if (config === null || didDoc === null) return 1;
	const doc = didDoc as DidDocument;
	const origin = flags.origin ?? new URL(doc.id.replace(/^did:web:/, 'https://')).origin;
	const result = await verifyDidConfiguration(config as DidConfiguration, doc, origin);
	if (result.valid) {
		ok(`valid domain linkage (did=${result.did}, origin=${result.origin})`);
		return 0;
	}
	printError(`✗ invalid domain linkage: ${result.reason ?? 'verification failed'}`);
	return 1;
}

async function verifyReceiptCmd(file: string): Promise<number> {
	const doc = await readJson(file);
	if (doc === null) return 1;
	const result = await verifyScittReceipt(doc as SignedStatement<ScittReceiptPayload>);
	if (result.valid) {
		ok(`valid SCITT receipt (log=${result.logId}, entry=${result.entryId})`);
		return 0;
	}
	printError(`✗ invalid SCITT receipt: ${result.reason ?? 'verification failed'}`);
	return 1;
}

export async function runVerify(args: string[]): Promise<number> {
	const [what] = args;
	if (what === '--help' || what === '-h' || what === undefined) {
		process.stdout.write(USAGE);
		return what === undefined ? 1 : 0;
	}
	const { values, positionals } = parseArgs({
		args: args.slice(1),
		options: {
			key: { type: 'string' },
			jwk: { type: 'string' },
			'did-doc': { type: 'string' },
			origin: { type: 'string' },
		},
		allowPositionals: true,
	});
	const file = positionals[0];
	const flags = values as Record<string, string>;
	if (!file) {
		printError('missing <file> argument');
		return 1;
	}
	switch (what) {
		case 'export':
			return verifyExport(file);
		case 'credential':
			return verifyCredentialCmd(file, flags);
		case 'did-configuration':
			return verifyDidConfigurationCmd(file, flags);
		case 'receipt':
			return verifyReceiptCmd(file);
		default:
			printError(`unknown verify target: ${what}`);
			process.stderr.write(USAGE);
			return 1;
	}
}
