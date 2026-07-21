// `facet keys generate [--alg EdDSA|ES256] [--out <file>]`: generate a deployment signing keypair for
// provenance. The PRIVATE JWK is what you store as the `FACET_SIGNING_JWK` Worker secret; the public
// half is published automatically at /.well-known/jwks.json. Ed25519 is the default (VC 2.0 Data
// Integrity `eddsa-jcs-2022` is Ed25519-only). Reuses @facet/trust's generator so the `kid` is the
// RFC 7638 thumbprint, exactly as the Worker expects.

import { chmod, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { type SigningAlg, generateSigningJwk } from '@facet/trust';
import pc from 'picocolors';
import { printError } from '../util.js';

const USAGE = `Usage: facet keys generate [flags]

Generate a deployment signing keypair for signed attestations, credentials, and exports.

  generate
    --alg <EdDSA|ES256>   Signature algorithm (default: EdDSA — required for eddsa-jcs-2022 VCs).
    --out <file>          Write the PRIVATE JWK to this file (default: print to stdout).

Store the PRIVATE JWK as the FACET_SIGNING_JWK Worker secret:
  facet keys generate --out signing.jwk && wrangler secret put FACET_SIGNING_JWK < signing.jwk
`;

async function runGenerate(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			alg: { type: 'string' },
			out: { type: 'string' },
		},
		allowPositionals: false,
	});
	const alg = (values.alg ?? 'EdDSA') as SigningAlg;
	if (alg !== 'EdDSA' && alg !== 'ES256') {
		printError(`--alg must be EdDSA or ES256 (got: ${values.alg})`);
		return 1;
	}

	const { privateJwk, publicJwk } = await generateSigningJwk(alg);
	const privateJson = JSON.stringify(privateJwk);

	if (values.out) {
		await writeFile(values.out, `${privateJson}\n`, { mode: 0o600 });
		// `mode` only applies when the file is CREATED; enforce 0600 explicitly so overwriting a
		// pre-existing (possibly world-readable) file never leaves the private key exposed.
		await chmod(values.out, 0o600);
		process.stdout.write(`${pc.green('✓')} wrote private signing JWK → ${values.out}\n`);
		process.stdout.write(
			`  ${pc.dim(`kid ${publicJwk.kid} (${alg}). Store it as a secret: wrangler secret put FACET_SIGNING_JWK < ${values.out}`)}\n`,
		);
		process.stdout.write(
			`  ${pc.yellow('Keep this file secret; delete it after uploading.')}\n`,
		);
	} else {
		// stdout: the private JWK only, so it pipes cleanly into `wrangler secret put`.
		process.stdout.write(`${privateJson}\n`);
		process.stderr.write(
			`${pc.dim(`kid ${publicJwk.kid} (${alg}) — pipe stdout into: wrangler secret put FACET_SIGNING_JWK`)}\n`,
		);
	}
	return 0;
}

export async function runKeys(args: string[]): Promise<number> {
	const [op] = args;
	if (op === undefined || op === '--help' || op === '-h') {
		process.stdout.write(USAGE);
		return op === undefined ? 1 : 0;
	}
	switch (op) {
		case 'generate':
			return runGenerate(args.slice(1));
		default:
			printError(`unknown keys op: ${op}`);
			process.stderr.write(USAGE);
			return 1;
	}
}
