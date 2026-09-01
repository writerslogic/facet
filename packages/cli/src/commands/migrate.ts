// `facet migrate`: apply D1 migrations via wrangler. The spawner is injectable for testing.

import { type SpawnOptions, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { printError } from '../util.js';

type SpawnLike = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => {
	on(event: 'close', listener: (code: number | null) => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
};

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
	// REQUIRED: parseArgs accepts `--db=--remote`, and an empty `--db=` survives `??`, either of which
	// reaches wrangler's argv as a flag or a blank token and migrates something other than `db`.
	if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(db)) {
		throw new Error(
			`invalid --db name: ${JSON.stringify(db)} (letters, digits, "-" and "_" only)`,
		);
	}
	const argv = ['d1', 'migrations', 'apply', db, values.remote ? '--remote' : '--local'];

	return new Promise((resolve) => {
		const child = spawnImpl('wrangler', argv, { stdio: 'inherit', shell: false });
		// Without this, a missing `wrangler` binary (not installed / not on PATH) throws an
		// uncaught ENOENT and dumps a raw Node stack trace instead of an actionable message.
		child.on('error', (err) => {
			printError(`could not run wrangler: ${err.message}`);
			printError('is wrangler installed and on PATH? try `pnpm install` at the repo root.');
			resolve(1);
		});
		// IMPORTANT: a null code is death by signal, so 0 would tell a deploy script an unfinished
		// migration succeeded. `lib/exec.ts` makes the same choice.
		child.on('close', (code) => resolve(code ?? 1));
	});
}
