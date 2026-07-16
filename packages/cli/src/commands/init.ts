// `countless init`: scaffold a wrangler.jsonc + .dev.vars for a self-hosted deployment. Prompts for
// any missing required value (skipped under --dry-run). Never makes network or wrangler calls.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';

function wranglerJsonc(name: string, db: string): string {
	return `{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "${name}",
	"main": "src/index.ts",
	"compatibility_date": "2026-07-01",
	"compatibility_flags": ["nodejs_compat"],
	"observability": { "enabled": true },
	"triggers": { "crons": ["0 * * * *"] },
	"assets": { "directory": "../dashboard/dist", "binding": "ASSETS" },
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${db}",
			"database_id": "PLACEHOLDER_D1_DATABASE_ID",
			"migrations_dir": "migrations"
		}
	],
	"unsafe": {
		"bindings": [
			{
				"name": "RATE_LIMITER",
				"type": "ratelimit",
				"namespace_id": "1001",
				"simple": { "limit": 100, "period": 60 }
			}
		]
	},
	"vars": { "RAW_RETENTION_DAYS": "90" }
}
`;
}

export async function runInit(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			name: { type: 'string' },
			db: { type: 'string' },
			dir: { type: 'string' },
			'dry-run': { type: 'boolean' },
		},
		allowPositionals: false,
	});

	const dryRun = Boolean(values['dry-run']);
	const dir = values.dir ?? '.';
	const db = values.db ?? 'countless';
	let name = values.name;

	if (!name) {
		if (dryRun) {
			name = 'countless';
		} else {
			const answer = await p.text({
				message: 'Worker name',
				placeholder: 'countless',
				defaultValue: 'countless',
			});
			if (p.isCancel(answer)) {
				return 1;
			}
			name = String(answer);
		}
	}

	mkdirSync(dir, { recursive: true });
	const adminToken = randomBytes(32).toString('hex');
	writeFileSync(join(dir, 'wrangler.jsonc'), wranglerJsonc(name, db));
	writeFileSync(join(dir, '.dev.vars'), `ADMIN_TOKEN=${adminToken}\n`);

	process.stdout.write(
		`Wrote wrangler.jsonc and .dev.vars to ${dir}.\nNext: run \`wrangler d1 create ${db}\` and put the id into wrangler.jsonc.\n`,
	);
	return 0;
}
