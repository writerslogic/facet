// `facet scaffold`: write a standalone wrangler.jsonc + .dev.vars outside the monorepo. Makes no
// network or wrangler calls. Self-hosters from a checkout want `facet init` instead — this exists for
// people wiring the Worker into their own repository layout.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { writeDevVar } from '../lib/store.js';

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

export async function runScaffold(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			name: { type: 'string' },
			db: { type: 'string' },
			dir: { type: 'string' },
		},
		allowPositionals: false,
	});

	const dir = values.dir ?? '.';
	const db = values.db ?? 'facet';
	const name = values.name ?? 'facet';

	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'wrangler.jsonc'), wranglerJsonc(name, db));
	// The dev admin token is a secret even locally: 0600, and never echoed to the terminal. Go
	// through `writeDevVar` for the 0600 guarantee rather than repeating it — and so scaffolding
	// into a directory that already has a .dev.vars upserts the token instead of destroying
	// whatever else (FACET_SIGNING_JWK) was in it.
	writeDevVar(join(dir, '.dev.vars'), 'ADMIN_TOKEN', randomBytes(32).toString('hex'));

	process.stdout.write(
		`Wrote wrangler.jsonc and .dev.vars (mode 0600) to ${dir}.\nNext: run \`facet init\` from a Facet checkout, or \`wrangler d1 create ${db}\` followed by \`facet config set-db-id --id <id>\`.\n`,
	);
	return 0;
}
