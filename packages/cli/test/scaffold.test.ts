// `facet scaffold` writes a standalone wrangler.jsonc + .dev.vars without prompting or network calls.

import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScaffold } from '../src/commands/scaffold.js';

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
});
