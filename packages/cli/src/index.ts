// facet-cli entrypoint: dispatches setup subcommands and the admin-API resource groups.

import { runConfig } from './commands/config.js';
import { runInit } from './commands/init.js';
import { runMigrate } from './commands/migrate.js';
import { isResourceCommand, runResource } from './commands/resources.js';
import { runStats } from './commands/stats.js';
import { runVerify } from './commands/verify.js';

const USAGE = `Usage: facet <command> [options]

Setup:
  init                         Scaffold wrangler.jsonc + .dev.vars
  migrate [--remote]           Apply D1 migrations via wrangler
  config set-db-id --id <id>   Write the D1 database_id into wrangler.jsonc
  config check                 Verify the D1 database_id is set (not the placeholder)

Reporting:
  stats --host <url> --key <k> --site <uuid>   Print summary stats

Verify (offline):
  verify export <file>                          Verify a signed stats export envelope
  verify credential <file> --key <z…>|--jwk <f> Verify a VC (eddsa-jcs-2022)
  verify did-configuration <file> --did-doc <f> Verify a DIF domain linkage

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
  facet config set-db-id --id 1a2b3c4d-... --config apps/server/wrangler.jsonc
  facet sites create --host https://a.example.com --admin-token $TOKEN --name Blog --domain blog.dev
  FACET_HOST=https://a.example.com FACET_ADMIN_TOKEN=$TOKEN facet keys issue --site <uuid> --label ci
  facet funnels create --site <uuid> --name Signup \\
    --steps '[{"type":"path","match_value":"/"},{"type":"path","match_value":"/done"}]'
`;

export async function main(argv: string[]): Promise<number> {
	const [command] = argv;
	switch (command) {
		case 'init':
			return runInit(argv.slice(1));
		case 'migrate':
			return runMigrate(argv.slice(1));
		case 'stats':
			return runStats(argv.slice(1));
		case 'config':
			return runConfig(argv.slice(1));
		case 'verify':
			return runVerify(argv.slice(1));
		case '--help':
		case '-h':
			process.stdout.write(USAGE);
			return 0;
		case undefined:
			process.stdout.write(USAGE);
			return 0;
		default:
			if (isResourceCommand(command)) {
				return runResource(command, argv.slice(1));
			}
			process.stderr.write(USAGE);
			return 1;
	}
}

const isMain =
	typeof process.argv[1] === 'string' &&
	import.meta.url === new URL(process.argv[1], 'file://').href;

if (isMain) {
	void main(process.argv.slice(2)).then((code) => process.exit(code));
}
