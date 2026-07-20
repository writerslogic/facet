// `facet keyattest verify <leaf.pem> --root <root.pem> --key <deploy-pub.pem|.crt> [flags]`: verify a
// real X.509 hardware key-attestation chain — the form HSMs / cloud-KMS-HSMs / YubiKeys / TPMs actually
// emit — using node:crypto `X509Certificate` (battle-tested path validation, NOT a hand-rolled ASN.1
// parser). We build leaf → (optional intermediates) → the configured PEM root, verify every issuer link
// (`checkIssued` + `verify(issuer.publicKey)`), check each cert is valid at `now`, and confirm the LEAF
// SPKI equals the deployment signing key's SPKI. hardware:true is reachable ONLY when the chain reaches
// the configured root AND the leaf key is the deployment key — the exact CLI-side analog of the
// workerd trust-anchor gate in @facet/trust keyattest.

import { X509Certificate, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { printError } from '../util.js';

const USAGE = `Usage: facet keyattest verify <leaf.pem> --root <root.pem> --key <file> [flags]

Verify an X.509 hardware key-attestation chain (the form real HSMs / YubiKeys / TPMs emit) and confirm
the leaf certifies the deployment signing key.

  verify <leaf.pem>            The attestation leaf certificate (the hardware-resident key's cert).
    --root <root.pem>          The CONFIGURED trust anchor (attestor/vendor root, self-signed CA). Required.
    --key <file>               The deployment signing key to bind to: a PEM public key, or a cert/PEM
                               whose SPKI is compared to the leaf's. Required.
    --intermediate <pem>       An intermediate CA PEM (repeatable) between leaf and root.
    --now <iso8601>            Verification time (default: now). Each cert must be valid at this instant.

hardware:true requires BOTH: the chain reaches the configured root AND the leaf SPKI == the deployment key.
`;

function ok(msg: string): void {
	process.stdout.write(`${pc.green('✓')} ${msg}\n`);
}

/** Read a PEM/DER file into an X509Certificate, or null (printing) on failure. */
async function readCert(path: string): Promise<X509Certificate | null> {
	try {
		return new X509Certificate(await readFile(path));
	} catch (err) {
		printError(
			`could not read certificate ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

/** Export a cert's or public key's SPKI (DER) for byte-exact comparison. Accepts a cert or a bare key. */
async function readSpki(path: string): Promise<Buffer | null> {
	let raw: Buffer;
	try {
		raw = await readFile(path);
	} catch (err) {
		printError(
			`could not read key ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
	// Try as a certificate first (extract its SPKI), then as a bare public key.
	try {
		return Buffer.from(
			new X509Certificate(raw).publicKey.export({
				type: 'spki',
				format: 'der',
			}),
		);
	} catch {
		try {
			return Buffer.from(createPublicKey(raw).export({ type: 'spki', format: 'der' }));
		} catch (err) {
			printError(
				`--key is neither a certificate nor a public key: ${err instanceof Error ? err.message : String(err)}`,
			);
			return null;
		}
	}
}

/** True iff `cert` is valid at `at` (validFrom <= at <= validTo). */
function validAt(cert: X509Certificate, at: Date): boolean {
	return at >= cert.validFromDate && at <= cert.validToDate;
}

/**
 * Verify the ordered chain leaf → intermediates… → root: every link must be issued by the next cert
 * (`checkIssued`) with a valid signature (`verify(issuer.publicKey)`), the root must be present and
 * self-signed, and every cert must be valid at `at`. Returns a reason string on failure, or null on OK.
 */
function verifyChain(chain: X509Certificate[], root: X509Certificate, at: Date): string | null {
	for (const cert of [...chain, root]) {
		if (!validAt(cert, at))
			return `certificate "${cert.subject}" is not valid at ${at.toISOString()}`;
	}
	// Link each cert to the next in the ordered list (leaf..last intermediate), then last → root.
	const ordered = [...chain, root];
	for (let i = 0; i < ordered.length - 1; i++) {
		const cert = ordered[i] as X509Certificate;
		const issuer = ordered[i + 1] as X509Certificate;
		if (!cert.checkIssued(issuer))
			return `"${cert.subject}" was not issued by "${issuer.subject}"`;
		if (!cert.verify(issuer.publicKey))
			return `signature on "${cert.subject}" does not verify against "${issuer.subject}"`;
	}
	// The configured root must be self-signed (a real trust anchor), else the chain is not anchored.
	if (!root.checkIssued(root) || !root.verify(root.publicKey)) {
		return `configured root "${root.subject}" is not a self-signed trust anchor`;
	}
	return null;
}

async function runVerify(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			root: { type: 'string' },
			key: { type: 'string' },
			intermediate: { type: 'string', multiple: true },
			now: { type: 'string' },
		},
		allowPositionals: true,
	});
	const leafPath = positionals[0];
	if (!leafPath) {
		printError('missing <leaf.pem> argument');
		return 1;
	}
	if (!values.root) {
		printError('provide the configured trust anchor with --root <root.pem>');
		return 1;
	}
	if (!values.key) {
		printError('provide the deployment signing key with --key <file>');
		return 1;
	}
	const at = values.now ? new Date(values.now) : new Date();
	if (Number.isNaN(at.getTime())) {
		printError(`--now is not a valid ISO-8601 date: ${values.now}`);
		return 1;
	}

	const leaf = await readCert(leafPath);
	const root = await readCert(values.root);
	if (!leaf || !root) return 1;
	const intermediates: X509Certificate[] = [];
	for (const path of values.intermediate ?? []) {
		const cert = await readCert(path);
		if (!cert) return 1;
		intermediates.push(cert);
	}
	const deploySpki = await readSpki(values.key);
	if (!deploySpki) return 1;

	// (1) Path validation to the configured root.
	const chainReason = verifyChain([leaf, ...intermediates], root, at);
	if (chainReason !== null) {
		printError(`✗ attestation chain does not verify: ${chainReason}`);
		return 1;
	}
	// (2) SPKI binding: the leaf must certify the deployment signing key, not some other key.
	const leafSpki = Buffer.from(leaf.publicKey.export({ type: 'spki', format: 'der' }));
	if (!leafSpki.equals(deploySpki)) {
		printError(
			'✗ leaf certificate does not certify the deployment signing key (SPKI mismatch)',
		);
		return 1;
	}

	ok(
		`hardware key-attestation verified (leaf="${leaf.subject}", anchored to root="${root.subject}")`,
	);
	process.stdout.write(
		`  ${pc.dim('leaf SPKI == deployment signing key; chain reaches the configured trust anchor.')}\n`,
	);
	return 0;
}

export async function runKeyattest(args: string[]): Promise<number> {
	const [op] = args;
	if (op === undefined || op === '--help' || op === '-h') {
		process.stdout.write(USAGE);
		return op === undefined ? 1 : 0;
	}
	switch (op) {
		case 'verify':
			return runVerify(args.slice(1));
		default:
			printError(`unknown keyattest op: ${op}`);
			process.stderr.write(USAGE);
			return 1;
	}
}
