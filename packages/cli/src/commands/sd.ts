// `facet sd <op> [flags]`: W3C Data Integrity selective disclosure with the standards cryptosuites
// `ecdsa-sd-2023` / `bbs-2023` (Node-only — they need RDF canonicalization + BLS crypto that do not
// run under Cloudflare Workers; the Worker uses the Workers-native SD in @facet/trust). All operations
// use a static, no-network document loader over the fixed VC 2.0 / Data-Integrity / Multikey contexts.
//   keygen  --suite <s> --out <keyfile>
//   issue   --suite <s> --credential <file> --key <keyfile> [--mandatory <ptr,...>] --out <file>
//   derive  --suite <s> --credential <signed> --key <keyfile> --reveal <ptr,...> --out <file>
//   verify  --suite <s> --presentation <file> --key <keyfile>

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import {
	type SdSuite,
	deriveSelective,
	exportIssuerKey,
	generateIssuerKey,
	importIssuerKey,
	issueSelective,
	verifySelective,
} from '../lib/cryptosuites.js';
import { printError } from '../util.js';

const USAGE = `Usage: facet sd <op> [flags]   (Node-only W3C selective disclosure)

Suites: ecdsa-sd-2023 | bbs-2023

Operations:
  keygen  --suite <s> --out <keyfile>
  issue   --suite <s> --credential <file> --key <keyfile> [--mandatory </a,/b>] --out <file>
  derive  --suite <s> --credential <signed> --key <keyfile> --reveal </a,/b> --out <file>
  verify  --suite <s> --presentation <file> --key <keyfile>
`;

function ok(msg: string): void {
	process.stdout.write(`${pc.green('✓')} ${msg}\n`);
}

async function readJson(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (err) {
		printError(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

function requireSuite(flags: Record<string, string | undefined>): SdSuite | null {
	const s = flags.suite;
	if (s === 'ecdsa-sd-2023' || s === 'bbs-2023') return s;
	printError('provide --suite ecdsa-sd-2023 | bbs-2023');
	return null;
}

function pointers(v: string | undefined): string[] {
	return v
		? v
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean)
		: [];
}

export async function runSd(args: string[]): Promise<number> {
	const [op] = args;
	if (op === undefined || op === '--help' || op === '-h') {
		process.stdout.write(USAGE);
		return op === undefined ? 1 : 0;
	}
	const { values } = parseArgs({
		args: args.slice(1),
		options: {
			suite: { type: 'string' },
			credential: { type: 'string' },
			presentation: { type: 'string' },
			key: { type: 'string' },
			out: { type: 'string' },
			mandatory: { type: 'string' },
			reveal: { type: 'string' },
		},
		allowPositionals: true,
	});
	const flags = values as Record<string, string | undefined>;

	switch (op) {
		case 'keygen': {
			const suite = requireSuite(flags);
			if (!suite || !flags.out) {
				if (suite) printError('provide --out <keyfile>');
				return 1;
			}
			const key = await generateIssuerKey(suite);
			await writeFile(flags.out, JSON.stringify(await exportIssuerKey(key), null, 2));
			ok(`generated ${suite} issuer key → ${flags.out} (controller ${key.controller})`);
			return 0;
		}
		case 'issue': {
			const suite = requireSuite(flags);
			if (!suite || !flags.credential || !flags.key || !flags.out) {
				if (suite) printError('provide --credential <file> --key <keyfile> --out <file>');
				return 1;
			}
			const cred = await readJson(flags.credential);
			const keyDoc = await readJson(flags.key);
			if (cred === null || keyDoc === null) return 1;
			const key = await importIssuerKey(keyDoc as Record<string, unknown>);
			const signed = await issueSelective(
				suite,
				cred as Record<string, unknown>,
				key,
				pointers(flags.mandatory).length ? pointers(flags.mandatory) : ['/issuer'],
			);
			await writeFile(flags.out, JSON.stringify(signed, null, 2));
			ok(`issued ${suite} credential → ${flags.out}`);
			return 0;
		}
		case 'derive': {
			const suite = requireSuite(flags);
			if (!suite || !flags.credential || !flags.key || !flags.reveal || !flags.out) {
				if (suite)
					printError(
						'provide --credential <signed> --key <keyfile> --reveal <ptrs> --out <file>',
					);
				return 1;
			}
			const signed = await readJson(flags.credential);
			const keyDoc = await readJson(flags.key);
			if (signed === null || keyDoc === null) return 1;
			const key = await importIssuerKey(keyDoc as Record<string, unknown>);
			const derived = await deriveSelective(
				suite,
				signed as Record<string, unknown>,
				key,
				pointers(flags.reveal),
			);
			await writeFile(flags.out, JSON.stringify(derived, null, 2));
			ok(`derived ${suite} presentation → ${flags.out}`);
			return 0;
		}
		case 'verify': {
			const suite = requireSuite(flags);
			if (!suite || !flags.presentation || !flags.key) {
				if (suite) printError('provide --presentation <file> --key <keyfile>');
				return 1;
			}
			const pres = await readJson(flags.presentation);
			const keyDoc = await readJson(flags.key);
			if (pres === null || keyDoc === null) return 1;
			const key = await importIssuerKey(keyDoc as Record<string, unknown>);
			const result = await verifySelective(suite, pres as Record<string, unknown>, key);
			if (result.verified) {
				ok(`valid ${suite} selective-disclosure proof`);
				return 0;
			}
			printError(`✗ invalid ${suite} proof: ${result.reason ?? 'verification failed'}`);
			return 1;
		}
		default:
			printError(`unknown sd op: ${op}`);
			process.stderr.write(USAGE);
			return 1;
	}
}
