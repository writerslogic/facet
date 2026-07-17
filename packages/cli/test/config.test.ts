// `facet config` tests: set-db-id writes the id while preserving comments/unrelated config, refuses
// to clobber a real id without --force, and check exits 1 on a placeholder / 0 on a real id.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConfig } from '../src/commands/config.js';

const FIXTURE = `{
  // Facet Worker config with a comment that must survive.
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "facet",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "facet",
      "database_id": "PLACEHOLDER_D1_DATABASE_ID", // ← paste real id here
      "migrations_dir": "migrations"
    }
  ]
}
`;

function tmpConfig(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'facet-cfg-'));
	const path = join(dir, 'wrangler.jsonc');
	writeFileSync(path, contents);
	return path;
}

describe('runConfig', () => {
	let stdout: string;
	let stderr: string;
	let outSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stdout = '';
		stderr = '';
		outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
			stdout += String(c);
			return true;
		});
		errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
			stderr += String(c);
			return true;
		});
	});

	afterEach(() => {
		outSpy.mockRestore();
		errSpy.mockRestore();
	});

	it('writes the database_id and preserves comments + unrelated config', () => {
		const path = tmpConfig(FIXTURE);
		const id = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
		const code = runConfig(['set-db-id', '--id', id, '--config', path]);
		expect(code).toBe(0);
		const out = readFileSync(path, 'utf8');
		expect(out).toContain(`"database_id": "${id}"`);
		expect(out).not.toContain('PLACEHOLDER_D1_DATABASE_ID');
		// Comments and unrelated fields preserved.
		expect(out).toContain('// Facet Worker config with a comment that must survive.');
		expect(out).toContain('// ← paste real id here');
		expect(out).toContain('"migrations_dir": "migrations"');
	});

	it('refuses to overwrite an existing real id without --force', () => {
		const existing = FIXTURE.replace(
			'PLACEHOLDER_D1_DATABASE_ID',
			'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
		);
		const path = tmpConfig(existing);
		const code = runConfig([
			'set-db-id',
			'--id',
			'11111111-2222-4333-8444-555555555555',
			'--config',
			path,
		]);
		expect(code).toBe(1);
		expect(stderr).toContain('Refusing to overwrite');
		// File is unchanged.
		expect(readFileSync(path, 'utf8')).toContain('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
	});

	it('overwrites an existing real id with --force', () => {
		const existing = FIXTURE.replace(
			'PLACEHOLDER_D1_DATABASE_ID',
			'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
		);
		const path = tmpConfig(existing);
		const next = '11111111-2222-4333-8444-555555555555';
		const code = runConfig(['set-db-id', '--id', next, '--config', path, '--force']);
		expect(code).toBe(0);
		expect(readFileSync(path, 'utf8')).toContain(`"database_id": "${next}"`);
	});

	it('set-db-id exits 1 when --id is missing', () => {
		const path = tmpConfig(FIXTURE);
		const code = runConfig(['set-db-id', '--config', path]);
		expect(code).toBe(1);
		expect(stderr).toContain('--id');
	});

	it('check exits 1 on the placeholder', () => {
		const path = tmpConfig(FIXTURE);
		const code = runConfig(['check', '--config', path]);
		expect(code).toBe(1);
		expect(stderr).toContain('placeholder');
	});

	it('check exits 0 on a real id', () => {
		const path = tmpConfig(
			FIXTURE.replace('PLACEHOLDER_D1_DATABASE_ID', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
		);
		const code = runConfig(['check', '--config', path]);
		expect(code).toBe(0);
		expect(stdout).toContain('is set');
	});

	it('check exits 1 when the config path does not exist', () => {
		const code = runConfig(['check', '--config', '/no/such/wrangler.jsonc']);
		expect(code).toBe(1);
		expect(stderr).toContain('not found');
	});

	it('unknown subcommand exits 1', () => {
		const code = runConfig(['bogus']);
		expect(code).toBe(1);
		expect(stderr).toContain('Usage');
	});
});
