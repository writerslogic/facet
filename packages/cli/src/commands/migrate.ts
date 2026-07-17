// `facet migrate`: apply D1 migrations via wrangler. The spawner is injectable for testing.

import { type SpawnOptions, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

type SpawnLike = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => { on(event: 'close', listener: (code: number | null) => void): void };

export function runMigrate(args: string[], spawnImpl: SpawnLike = spawn): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			db: { type: 'string' },
			remote: { type: 'boolean' },
		},
		allowPositionals: false,
	});

	const db = values.db ?? 'facet';
	const argv = ['d1', 'migrations', 'apply', db, values.remote ? '--remote' : '--local'];

	return new Promise((resolve) => {
		const child = spawnImpl('wrangler', argv, { stdio: 'inherit' });
		child.on('close', (code) => resolve(code ?? 0));
	});
}
