// facet-cli entrypoint: dispatches setup subcommands and the admin-API resource groups.

import { runBots } from './commands/bots.js';
import { runConfig } from './commands/config.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { runKeyattest } from './commands/keyattest.js';
import { runKeys } from './commands/keys.js';
import { runMigrate } from './commands/migrate.js';
import { isResourceCommand, runResource } from './commands/resources.js';
import { runScaffold } from './commands/scaffold.js';
import { runSd } from './commands/sd.js';
import { runStats } from './commands/stats.js';
import { runVerify } from './commands/verify.js';
import { printError } from './util.js';

const USAGE = `Usage: facet <command> [options]

Setup:
  init                         Install Facet end to end: D1, secrets, migrations, deploy, first
                               site + API key. Safe to re-run — it resumes where it stopped.
      --dry-run                Print the plan and change nothing
      --yes                    Accept every default (non-interactive)
      --hostname <h>           Serve on your own domain (default: the free *.workers.dev URL)
      --workers-dev            Force the *.workers.dev URL
      --site-name <n> --site-domain <d>   Skip the two prompts
      --new-key                Issue another API key for the site
      --rotate-admin-token     Replace the deployed ADMIN_TOKEN
  doctor                       Diagnose an install: what is configured, missing, and what to run
  scaffold [--dir <d>]         Write a standalone wrangler.jsonc + .dev.vars (outside a checkout)
  migrate [--remote]           Apply D1 migrations via wrangler
  config set-db-id --id <id>   Write the D1 database_id into wrangler.jsonc
  config check                 Verify the D1 database_id is set (not the placeholder)
  keys generate [--alg <a>]    Generate a deployment signing keypair (FACET_SIGNING_JWK)

Reporting:
  stats --host <url> --key <k> --site <uuid>   Print summary stats

Bot ruleset (admin API — needs --host + --admin-token, or FACET_HOST/FACET_ADMIN_TOKEN):
  bots status                  Show the stored crawler ruleset (source, pattern count, updated, etag)
  bots refresh                 Re-fetch FACET_BOT_RULESET_URL now, without a redeploy

Verify (offline):
  verify export <file>                          Verify a signed stats export envelope
  verify credential <file> --key <z…>|--jwk <f> Verify a VC (eddsa-jcs-2022)
  verify did-configuration <file> --did-doc <f> Verify a DIF domain linkage

Selective disclosure (Node-only W3C cryptosuites):
  sd keygen --suite <ecdsa-sd-2023|bbs-2023> --out <keyfile>
  sd issue  --suite <s> --credential <f> --key <keyfile> [--mandatory </a,/b>] --out <f>
  sd derive --suite <s> --credential <signed> --key <keyfile> --reveal </a,/b> --out <f>
  sd verify --suite <s> --presentation <f> --key <keyfile>

Hardware key-attestation (Node-only X.509 chain via node:crypto):
  keyattest verify <leaf.pem> --root <root.pem> --key <deploy-pub|.crt> [--intermediate <pem>] [--now <iso>]

Resources (admin API — needs --host + --admin-token, or FACET_HOST/FACET_ADMIN_TOKEN):
  sites list | create --name <n> --domain <d>
  keys list --site <uuid> | issue --site <uuid> [--label <l>] | revoke --id <uuid> --site <uuid>
  goals list --site <uuid> | create --site <uuid> --name <n> --type <event|path> --match <v>
       | delete --id <uuid> --site <uuid>
  funnels list --site <uuid> | create --site <uuid> --name <n> --steps <json>
       | delete --id <uuid> --site <uuid>
  experiments list --site <uuid> | create --site <uuid> --name <n> --flag <key> --variants <json>
       | delete --id <uuid> --site <uuid>

All resource commands support --json for machine-readable output.

Examples:
  facet init                                       # from a fresh clone: everything, one command
  facet init --dry-run                             # show the plan without touching anything
  facet doctor                                     # paste this into a bug report
  facet config set-db-id --id 1a2b3c4d-... --config apps/server/wrangler.jsonc
  facet sites create --host https://a.example.com --admin-token $TOKEN --name Blog --domain blog.dev
  FACET_HOST=https://a.example.com FACET_ADMIN_TOKEN=$TOKEN facet keys issue --site <uuid> --label ci
  facet funnels create --site <uuid> --name Signup \\
    --steps '[{"type":"path","match_value":"/"},{"type":"path","match_value":"/done"}]'
`;

export async function main(argv: string[]): Promise<number> {
	const [command] = argv;
	// A single error boundary for every command: a bad/incomplete flag (parseArgs throws) or any other
	// error becomes a clean one-line message and exit 1, never a raw Node stack trace.
	try {
		switch (command) {
			case 'init':
				return await runInit(argv.slice(1));
			case 'doctor':
				return await runDoctor(argv.slice(1));
			case 'scaffold':
				return await runScaffold(argv.slice(1));
			case 'migrate':
				return await runMigrate(argv.slice(1));
			case 'stats':
				return await runStats(argv.slice(1));
			case 'bots':
				return await runBots(argv.slice(1));
			case 'config':
				return await runConfig(argv.slice(1));
			case 'keys':
				return await runKeys(argv.slice(1));
			case 'verify':
				return await runVerify(argv.slice(1));
			case 'sd':
				return await runSd(argv.slice(1));
			case 'keyattest':
				return await runKeyattest(argv.slice(1));
			case '--help':
			case '-h':
				process.stdout.write(USAGE);
				return 0;
			case undefined:
				process.stdout.write(USAGE);
				return 0;
			default:
				if (isResourceCommand(command)) {
					return await runResource(command, argv.slice(1));
				}
				process.stderr.write(USAGE);
				return 1;
		}
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

const isMain =
	typeof process.argv[1] === 'string' &&
	import.meta.url === new URL(process.argv[1], 'file://').href;

if (isMain) {
	void main(process.argv.slice(2)).then((code) => process.exit(code));
}
