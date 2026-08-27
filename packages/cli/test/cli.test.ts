import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

describe('main dispatcher', () => {
	let stdout: string;
	let stderr: string;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stdout = '';
		stderr = '';
		stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it('returns 0 and prints usage with no args', async () => {
		const code = await main([]);
		expect(code).toBe(0);
		expect(stdout).toContain('Usage: facet');
	});

	it('returns 0 and prints usage for --help', async () => {
		const code = await main(['--help']);
		expect(code).toBe(0);
		expect(stdout).toContain('Usage: facet');
	});

	it('returns 0 and prints usage for -h', async () => {
		const code = await main(['-h']);
		expect(code).toBe(0);
		expect(stdout).toContain('Usage: facet');
	});

	it('returns 1 and prints usage to stderr for unknown command', async () => {
		const code = await main(['bogus']);
		expect(code).toBe(1);
		expect(stderr).toContain('Usage: facet');
	});

	it('routes to stats and surfaces its failure exit code on missing options', async () => {
		const code = await main(['stats']);
		expect(code).toBe(1);
		expect(stderr).toContain('required');
	});

	// `keys` names two commands: the local signing-keypair generator and the admin-API key resource
	// group. Routing the whole group to the generator made `keys list|issue|revoke` — all three of them
	// in USAGE — answer "unknown keys op".
	it('splits keys between the signing generator and the admin-API resource group', async () => {
		expect(await main(['keys', 'issue'])).toBe(1);
		expect(stderr).not.toContain('unknown keys op');
		stderr = '';
		expect(await main(['keys', 'bogus'])).toBe(1);
		expect(stderr).toContain('unknown keys op');
	});

	it('routes import and surfaces its failure exit code on missing options', async () => {
		const code = await main(['import']);
		expect(code).toBe(1);
		expect(stderr).toContain('host');
	});
});
