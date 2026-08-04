// `facet scaffold` writes a standalone wrangler.jsonc + .dev.vars without prompting or network calls.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScaffold } from '../src/commands/scaffold.js';
import { writeDevVar } from '../src/lib/store.js';

describe('runScaffold', () => {
	let stdout: string;
	let spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stdout = '';
		spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
	});

	afterEach(() => spy.mockRestore());

	it('scaffolds wrangler.jsonc and a 0600 .dev.vars', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'facet-scaffold-'));
		const code = await runScaffold(['--name', 'demo', '--db', 'facet', '--dir', dir]);
		expect(code).toBe(0);

		const wrangler = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8');
		expect(wrangler).toContain('"name": "demo"');
		expect(wrangler).toContain('"database_name": "facet"');
		expect(wrangler).toContain('PLACEHOLDER_D1_DATABASE_ID');

		const devVarsPath = join(dir, '.dev.vars');
		const devVars = readFileSync(devVarsPath, 'utf8');
		expect(devVars).toMatch(/^ADMIN_TOKEN=[0-9a-f]{64}\n$/);
		// The generated token is a secret even in development: not world-readable, never echoed.
		expect(statSync(devVarsPath).mode & 0o777).toBe(0o600);
		expect(stdout).not.toContain(devVars.trim().split('=')[1]);
	});

	it('tightens a .dev.vars that already exists world-readable', () => {
		// `writeFileSync(path, data, {mode})` applies the mode only when it CREATES the file, so a
		// pre-existing 0644 .dev.vars — written by hand, or widened by a umask — would otherwise take
		// the secret at its old mode. Same guarantee `facet keys --out` makes; see keys.test.ts.
		//
		// This pins the end state only. It cannot see WHEN the mode was tightened, and the ordering is
		// the actual fix: chmod runs before the write, so the secret never lands under the old mode.
		// A regression that moved the chmod back after the write would still pass here.
		const dir = mkdtempSync(join(tmpdir(), 'facet-devvars-'));
		const devVarsPath = join(dir, '.dev.vars');
		writeFileSync(devVarsPath, 'EXISTING=keepme\n', { mode: 0o644 });

		writeDevVar(devVarsPath, 'ADMIN_TOKEN', 'secret-value');

		expect(statSync(devVarsPath).mode & 0o777).toBe(0o600);
		const written = readFileSync(devVarsPath, 'utf8');
		expect(written).toContain('ADMIN_TOKEN=secret-value');
		// Other lines are preserved byte-for-byte.
		expect(written).toContain('EXISTING=keepme');
	});
});
