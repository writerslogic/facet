// T035: `countless migrate` builds the correct wrangler argv (default --local, --remote when asked)
// and resolves to the child exit code, via an injected spawner (no real wrangler call).

import { describe, expect, it } from 'vitest';
import { runMigrate } from '../src/commands/migrate.js';

function fakeSpawn(exitCode = 0) {
	const calls: { command: string; args: string[] }[] = [];
	const spawn = (command: string, args: string[]) => {
		calls.push({ command, args });
		return {
			on(_event: 'close', listener: (code: number | null) => void) {
				listener(exitCode);
			},
		};
	};
	return { spawn, calls };
}

describe('runMigrate', () => {
	it('applies migrations remotely when --remote is passed', async () => {
		const { spawn, calls } = fakeSpawn();
		const code = await runMigrate(['--db', 'countless', '--remote'], spawn);
		expect(code).toBe(0);
		expect(calls[0]?.command).toBe('wrangler');
		expect(calls[0]?.args).toEqual(['d1', 'migrations', 'apply', 'countless', '--remote']);
	});

	it('defaults to --local and the countless db', async () => {
		const { spawn, calls } = fakeSpawn(0);
		await runMigrate([], spawn);
		expect(calls[0]?.args).toEqual(['d1', 'migrations', 'apply', 'countless', '--local']);
	});

	it('resolves to a non-zero child exit code', async () => {
		const { spawn } = fakeSpawn(2);
		expect(await runMigrate(['--remote'], spawn)).toBe(2);
	});
});
