// `facet scaffold` writes a standalone wrangler.jsonc + .dev.vars without prompting or network calls.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScaffold } from '../src/commands/scaffold.js';

describe('runScaffold', () => {
	let stdout: string;
	let stderr: string;
	let spy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stdout = '';
		stderr = '';
		spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
		errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});
	});

	afterEach(() => {
		spy.mockRestore();
		errSpy.mockRestore();
	});

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

	it('refuses to overwrite an existing wrangler.jsonc without --force', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'facet-scaffold-'));
		const wranglerPath = join(dir, 'wrangler.jsonc');
		writeFileSync(wranglerPath, '{"name":"real-user-config"}');

		const code = await runScaffold(['--name', 'demo', '--dir', dir]);
		expect(code).toBe(1);
		expect(stderr).toContain('Refusing to overwrite');
		// The real config must survive untouched.
		expect(readFileSync(wranglerPath, 'utf8')).toBe('{"name":"real-user-config"}');
	});

	it('overwrites an existing wrangler.jsonc when --force is passed', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'facet-scaffold-'));
		const wranglerPath = join(dir, 'wrangler.jsonc');
		writeFileSync(wranglerPath, '{"name":"real-user-config"}');

		const code = await runScaffold(['--name', 'demo', '--dir', dir, '--force']);
		expect(code).toBe(0);
		expect(readFileSync(wranglerPath, 'utf8')).toContain('"name": "demo"');
	});
});
