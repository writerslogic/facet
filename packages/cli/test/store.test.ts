// The one place a secret touches the disk. These tests pin the ordering, not just the end state:
// a regression that widened the window between deciding the mode and writing the token would leave
// ADMIN_TOKEN readable, and `statSync` after the fact cannot see that.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDevVar, writeDevVar } from '../src/lib/store.js';

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs')>();
	const record = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
		((...args: never[]) => {
			calls.push(name);
			return fn(...args);
		}) as T;
	return {
		...real,
		existsSync: record('existsSync', real.existsSync),
		fchmodSync: record('fchmodSync', real.fchmodSync),
		ftruncateSync: record('ftruncateSync', real.ftruncateSync),
		openSync: record('openSync', real.openSync),
		writeFileSync: record('writeFileSync', real.writeFileSync),
	};
});

function scratchDevVars(): string {
	return join(mkdtempSync(join(tmpdir(), 'facet-devvars-')), '.dev.vars');
}

describe('writeDevVar', () => {
	beforeEach(() => {
		calls.length = 0;
	});

	it('creates a missing .dev.vars at 0600', () => {
		const path = scratchDevVars();

		writeDevVar(path, 'ADMIN_TOKEN', 'secret-value');

		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, 'utf8')).toBe('ADMIN_TOKEN=secret-value\n');
	});

	it('tightens a .dev.vars that already exists world-readable, before writing the secret', () => {
		// `writeFileSync(path, data, {mode})` applies the mode only when it CREATES the file, so a
		// pre-existing 0644 .dev.vars — written by hand, or widened by a umask — would otherwise take
		// the secret at its old mode. Same guarantee `facet keys --out` makes; see keys.test.ts.
		const path = scratchDevVars();
		writeFileSync(path, 'EXISTING=keepme\n', { mode: 0o644 });
		calls.length = 0;

		writeDevVar(path, 'ADMIN_TOKEN', 'secret-value');

		expect(statSync(path).mode & 0o777).toBe(0o600);
		// The ordering is the fix: the mode is settled on the descriptor before any byte is written.
		expect(calls.indexOf('fchmodSync')).toBeGreaterThanOrEqual(0);
		expect(calls.indexOf('fchmodSync')).toBeLessThan(calls.indexOf('writeFileSync'));

		const written = readFileSync(path, 'utf8');
		expect(written).toContain('ADMIN_TOKEN=secret-value');
		// Other lines are preserved byte-for-byte.
		expect(written).toContain('EXISTING=keepme');
	});

	it('never probes the path before acting on it', () => {
		// An `existsSync` here would reintroduce the check-then-use window the descriptor closes: the
		// path could be replaced between the probe and the write, and the mode would land elsewhere.
		const path = scratchDevVars();
		writeFileSync(path, 'EXISTING=keepme\n', { mode: 0o644 });
		calls.length = 0;

		writeDevVar(path, 'ADMIN_TOKEN', 'secret-value');
		readDevVar(path, 'ADMIN_TOKEN');
		writeDevVar(path, 'ADMIN_TOKEN', 'rotated');

		expect(calls).not.toContain('existsSync');
	});

	it('replaces an existing key in place rather than appending a duplicate', () => {
		const path = scratchDevVars();
		writeDevVar(path, 'ADMIN_TOKEN', 'first');

		writeDevVar(path, 'ADMIN_TOKEN', 'second');

		expect(readFileSync(path, 'utf8')).toBe('ADMIN_TOKEN=second\n');
		expect(readDevVar(path, 'ADMIN_TOKEN')).toBe('second');
	});

	it('truncates when the new content is shorter than the old', () => {
		// `a+` pins writes to end-of-file; without the truncate the shorter rewrite would leave a tail
		// of the previous value — including the previous secret — behind it.
		const path = scratchDevVars();
		writeDevVar(path, 'ADMIN_TOKEN', 'a-very-long-previous-secret-value');

		writeDevVar(path, 'ADMIN_TOKEN', 'short');

		expect(readFileSync(path, 'utf8')).toBe('ADMIN_TOKEN=short\n');
	});
});

describe('readDevVar', () => {
	it('returns null for a missing file', () => {
		expect(readDevVar(scratchDevVars(), 'ADMIN_TOKEN')).toBeNull();
	});

	it('returns null for a missing key and ignores comments', () => {
		const path = scratchDevVars();
		writeFileSync(path, '# ADMIN_TOKEN=commented-out\nOTHER=value\n', { mode: 0o600 });

		expect(readDevVar(path, 'ADMIN_TOKEN')).toBeNull();
		expect(readDevVar(path, 'OTHER')).toBe('value');
	});

	it('propagates errors that are not ENOENT', () => {
		// A directory where the file should be is an operator mistake worth surfacing, not a silent
		// "no token configured" that sends `facet init` down the wrong branch.
		const dir = mkdtempSync(join(tmpdir(), 'facet-devvars-'));

		expect(() => readDevVar(dir, 'ADMIN_TOKEN')).toThrow();
	});
});
