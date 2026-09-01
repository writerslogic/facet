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
	type EatClaims,
	type ScittReceiptPayload,
	type SignedExport,
	type SignedStatement,
	type VerifiableCredential,
	didWebToUrl,
	verifyCredential,
	verifyDidConfiguration,
	verifyProcessEvidence,
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
  attestation <file> [--nonce <n>]               Verify a RATS process-evidence EAT (software only).
`;

// IMPORTANT: every value printed below is read out of the artifact under examination, and an offline
// "✓ valid" only means self-consistent — anyone can sign an envelope with their own key. Raw C0/C1
// bytes would let that document rewrite the verdict line it is printed beside; V8 embeds a snippet of
// the file in its own JSON.parse message, so even an unparseable artifact reaches the terminal.
// Every field below is typed by a cast over arbitrary JSON, so `String(value)` on a non-string throws
// (`{"toString":"x"}` has no callable toString); only string and number are converted.
function printable(value: unknown, fallback = ''): string {
	const raw =
		typeof value === 'number'
			? String(value)
			: typeof value === 'string' && value
				? value
				: fallback;
	let out = '';
	for (const ch of raw) {
		const code = ch.codePointAt(0) ?? 0;
		const spoofing =
			code < 0x20 ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069);
		out += spoofing ? '�' : ch;
		if (out.length >= 200) return `${out}…`;
	}
	return out;
}

/** Read + parse a JSON object, returning null (and printing) on any error. */
async function readJson(path: string): Promise<unknown | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			printError(`could not read ${path}: expected a JSON object`);
			return null;
		}
		return parsed;
	} catch (err) {
		printError(
			`could not read ${path}: ${printable(err instanceof Error ? err.message : String(err))}`,
		);
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
		ok(`valid signed export (alg=${printable(result.alg)}, kid=${printable(result.kid)})`);
		if (result.jwksUrl) {
			// IMPORTANT: jwksUrl is a plain proof field that no signature covers, so a self-signed
			// envelope names any URL it likes. Telling the operator to confirm the kid *there* was a
			// trust elevation the attacker controlled both ends of.
			process.stdout.write(`  self-asserted key location: ${printable(result.jwksUrl)}\n`);
			process.stdout.write(
				`  ${pc.dim('note: this URL is not signed; confirm the kid against the JWKS of the deployment you already trust, not against this URL.')}\n`,
			);
		}
		return 0;
	}
	printError(`✗ invalid signed export: ${printable(result.reason, 'signature did not verify')}`);
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
		ok(`valid credential (issuer=${printable(result.issuer, 'unknown')})`);
		return 0;
	}
	printError(`✗ invalid credential: ${printable(result.reason, 'signature did not verify')}`);
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
	// Derive the expected origin through the trust package's own resolver rather than by string
	// surgery on the DID. `did:web:host%3A8443` is a PORT, and stripping the prefix hands `%3A` to the
	// URL parser as part of the hostname — a legitimate ported deployment then failed its own linkage
	// check. It also runs the DID through didWebToUrl's host validation before it reaches a URL.
	// REQUIRED: `||`, not `??` — `--origin=` parses to '' and would otherwise be compared as an origin.
	let origin: string;
	try {
		origin = flags.origin || new URL(didWebToUrl(doc.id)).origin;
	} catch (e) {
		printError(
			`✗ invalid DID document id: ${printable(e instanceof Error ? e.message : '', 'bad did:web')}`,
		);
		return 1;
	}
	const result = await verifyDidConfiguration(config as DidConfiguration, doc, origin);
	if (result.valid) {
		ok(
			`valid domain linkage (did=${printable(result.did)}, origin=${printable(result.origin)})`,
		);
		return 0;
	}
	printError(`✗ invalid domain linkage: ${printable(result.reason, 'verification failed')}`);
	return 1;
}

async function verifyReceiptCmd(file: string): Promise<number> {
	const doc = await readJson(file);
	if (doc === null) return 1;
	const result = await verifyScittReceipt(doc as SignedStatement<ScittReceiptPayload>);
	if (result.valid) {
		ok(
			`valid SCITT receipt (log=${printable(result.logId)}, entry=${printable(result.entryId)})`,
		);
		return 0;
	}
	printError(`✗ invalid SCITT receipt: ${printable(result.reason, 'verification failed')}`);
	return 1;
}

async function verifyAttestationCmd(file: string, flags: Record<string, string>): Promise<number> {
	const doc = await readJson(file);
	if (doc === null) return 1;
	const result = await verifyProcessEvidence(doc as SignedStatement<EatClaims>, {
		nonce: flags.nonce,
	});
	if (result.valid) {
		ok(
			`valid RATS process evidence (key-bound, build=${printable(result.evidence?.buildId, 'unknown')})`,
		);
		process.stdout.write(
			`  ${pc.dim('software attestation only — no hardware root of trust')}\n`,
		);
		// rats.ts only compares eat_nonce when a nonce is supplied, so without --nonce a replayed EAT
		// verifies exactly like a fresh one.
		if (!flags.nonce) {
			process.stdout.write(
				`  ${pc.dim('freshness unchecked: pass --nonce <n> to bind this to your challenge')}\n`,
			);
		}
		return 0;
	}
	printError(`✗ invalid attestation: ${printable(result.reason, 'verification failed')}`);
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
			nonce: { type: 'string' },
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
		case 'attestation':
			return verifyAttestationCmd(file, flags);
		default:
			printError(`unknown verify target: ${what}`);
			process.stderr.write(USAGE);
			return 1;
	}
}
