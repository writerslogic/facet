// `facet migrate` builds the wrangler argv (default --local) and resolves to the child exit code.

import { describe, expect, it, vi } from 'vitest';
import { runMigrate } from '../src/commands/migrate.js';

function fakeSpawn(exitCode = 0) {
	const calls: { command: string; args: string[] }[] = [];
	const spawn = (command: string, args: string[]) => {
		calls.push({ command, args });
		return {
			on(event: 'close' | 'error', listener: (arg: number | null | Error) => void) {
				if (event === 'close') listener(exitCode);
			},
		};
	};
	return { spawn, calls };
}

/** A spawn that fails before the child even starts (e.g. `wrangler` missing from PATH). */
function fakeSpawnError(message: string) {
	const spawn = () => ({
		on(event: 'close' | 'error', listener: (arg: number | null | Error) => void) {
			if (event === 'error') listener(new Error(message));
		},
	});
	return spawn;
}

describe('runMigrate', () => {
	it('applies migrations remotely when --remote is passed', async () => {
		const { spawn, calls } = fakeSpawn();
		const code = await runMigrate(['--db', 'facet', '--remote'], spawn);
		expect(code).toBe(0);
		expect(calls[0]?.command).toBe('wrangler');
		expect(calls[0]?.args).toEqual(['d1', 'migrations', 'apply', 'facet', '--remote']);
	});

	it('defaults to --local and the facet db', async () => {
		const { spawn, calls } = fakeSpawn(0);
		await runMigrate([], spawn);
		expect(calls[0]?.args).toEqual(['d1', 'migrations', 'apply', 'facet', '--local']);
	});

	it('resolves to a non-zero child exit code', async () => {
		const { spawn } = fakeSpawn(2);
		expect(await runMigrate(['--remote'], spawn)).toBe(2);
	});

	it('reports a clean error instead of throwing when the child cannot be spawned (e.g. wrangler missing)', async () => {
		const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			const code = await runMigrate([], fakeSpawnError('spawn wrangler ENOENT'));
			expect(code).toBe(1);
			expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('ENOENT');
		} finally {
			errSpy.mockRestore();
		}
	});
});
