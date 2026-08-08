import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const source = join(root, 'apps/server/migrations');
const migrations = readdirSync(source).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
if (migrations.length < 2) throw new Error('At least two migrations are required for an upgrade test.');
const latest = migrations.at(-1);
const temp = mkdtempSync(join(tmpdir(), 'facet-migration-upgrade-'));
const migrationDir = join(temp, 'migrations');
const state = join(temp, 'state');
mkdirSync(migrationDir);
writeFileSync(
	join(temp, 'wrangler.jsonc'),
	JSON.stringify({
		name: 'facet-migration-test',
		compatibility_date: '2026-01-01',
		d1_databases: [
			{
				binding: 'DB',
				database_name: 'facet-migration-test',
				database_id: 'local',
				migrations_dir: migrationDir,
			},
		],
	}),
);

function apply() {
	const result = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'facet-migration-test', '--local', '--config', join(temp, 'wrangler.jsonc'), '--persist-to', state], { cwd: root, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

try {
	for (const name of migrations.slice(0, -1)) cpSync(join(source, name), join(migrationDir, name));
	apply();
	cpSync(join(source, latest), join(migrationDir, basename(latest)));
	apply();
	console.log(`Upgrade through ${latest} succeeded.`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
