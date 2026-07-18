// `facet verify <what> <file>`: offline verifiers for Facet's signed artifacts, all backed by
// @facet/trust (never re-implemented here). `export` is the first: it validates a signed-export
// envelope's detached JWS against its embedded public key, fully offline. Later phases add
// `credential`, `receipt`, and `did` subcommands.

import { readFile } from 'node:fs/promises';
import { type SignedExport, verifySignedExport } from '@facet/trust';
import pc from 'picocolors';
import { printError } from '../util.js';

const USAGE = `Usage: facet verify export <file>

Verify a signed stats export (a "facet-signed-export/1" JSON envelope) offline against the
public key embedded in its proof. Produce the envelope with:

  curl -H "Authorization: Bearer <key>" \\
    "<host>/api/stats/export?site_id=<uuid>&start=<ms>&end=<ms>&format=json&sign=1" > export.json
  facet verify export export.json
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

async function verifyExport(path: string): Promise<number> {
	const doc = await readJson(path);
	if (doc === null) return 1;
	const result = await verifySignedExport(doc as SignedExport);
	if (result.valid) {
		process.stdout.write(`${pc.green('✓ valid')} signed export\n`);
		process.stdout.write(`  alg: ${result.alg}\n`);
		process.stdout.write(`  kid: ${result.kid}\n`);
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

export async function runVerify(args: string[]): Promise<number> {
	const [what, file] = args;
	if (what === '--help' || what === '-h' || what === undefined) {
		process.stdout.write(USAGE);
		return what === undefined ? 1 : 0;
	}
	if (what !== 'export') {
		printError(`unknown verify target: ${what}`);
		process.stderr.write(USAGE);
		return 1;
	}
	if (!file) {
		printError('missing <file> argument');
		return 1;
	}
	return verifyExport(file);
}
