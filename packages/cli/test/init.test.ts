// `facet init --dry-run` scaffolds wrangler.jsonc + .dev.vars without prompting or network calls.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';

describe('runInit', () => {
	it('scaffolds wrangler.jsonc and .dev.vars under --dry-run', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'facet-init-'));
		const code = await runInit(['--dry-run', '--name', 'demo', '--db', 'facet', '--dir', dir]);
		expect(code).toBe(0);

		const wrangler = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8');
		expect(wrangler).toContain('"name": "demo"');
		expect(wrangler).toContain('"database_name": "facet"');

		const devVars = readFileSync(join(dir, '.dev.vars'), 'utf8');
		expect(devVars).toMatch(/^ADMIN_TOKEN=[0-9a-f]{64}\n$/);
	});
});
