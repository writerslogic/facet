// Resource-command tests: dispatch/parse, mocked-API list/create/delete for each group, required-flag
// and non-2xx failures, and the security invariant that the admin token rides the Authorization
// header but is NEVER printed to stdout/stderr.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runResource } from '../src/commands/resources.js';
import { main } from '../src/index.js';

const HOST = 'https://a.example.com';
const TOKEN = 'super-secret-admin-token';
const SITE = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '22222222-2222-4222-8222-222222222222';

type Call = { url: string; init?: RequestInit };

function recorder(impl: (call: Call) => unknown) {
	const calls: Call[] = [];
	const fetchImpl = (url: string, init?: RequestInit) => {
		const call = { url, init };
		calls.push(call);
		return Promise.resolve(impl(call));
	};
	return { fetchImpl: fetchImpl as never, calls };
}

function auth(init?: RequestInit): string | undefined {
	const headers = init?.headers as Record<string, string> | undefined;
	return headers?.Authorization;
}

describe('resource commands', () => {
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
		vi.unstubAllEnvs();
	});

	const base = ['--host', HOST, '--admin-token', TOKEN];

	// ── sites ──────────────────────────────────────────────────────────────
	it('sites list renders rows and sends the admin token in the header only', async () => {
		const { fetchImpl, calls } = recorder(() => ({
			sites: [{ id: SITE, name: 'Blog', domain: 'blog.dev', created_at: 0 }],
		}));
		const code = await runResource('sites', ['list', ...base], fetchImpl);
		expect(code).toBe(0);
		expect(stdout).toContain('Blog');
		expect(stdout).toContain('blog.dev');
		expect(calls[0]?.url).toBe(`${HOST}/api/sites`);
		expect(auth(calls[0]?.init)).toBe(`Bearer ${TOKEN}`);
		// Security: the token must not leak into any output.
		expect(stdout).not.toContain(TOKEN);
		expect(stderr).not.toContain(TOKEN);
	});

	it('sites create posts name + domain with auth', async () => {
		const { fetchImpl, calls } = recorder(() => ({
			site: { id: SITE, name: 'Blog', domain: 'blog.dev', created_at: 0 },
		}));
		const code = await runResource(
			'sites',
			['create', '--name', 'Blog', '--domain', 'blog.dev', ...base],
			fetchImpl,
		);
		expect(code).toBe(0);
		expect(calls[0]?.init?.method).toBe('POST');
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			name: 'Blog',
			domain: 'blog.dev',
		});
		expect(auth(calls[0]?.init)).toBe(`Bearer ${TOKEN}`);
		expect(stdout).not.toContain(TOKEN);
	});

	it('sites create fails with exit 1 when --domain is missing', async () => {
		const { fetchImpl, calls } = recorder(() => ({}));
		const code = await runResource('sites', ['create', '--name', 'Blog', ...base], fetchImpl);
		expect(code).toBe(1);
		expect(stderr).toContain('domain');
		expect(calls.length).toBe(0);
	});

	// ── keys ─────────────────────────────────────────────────────────────────
	it('keys list validates the site UUID and lists rows', async () => {
		const { fetchImpl, calls } = recorder(() => ({
			keys: [
				{
					id: KEY_ID,
					site_id: SITE,
					label: 'ci',
					created_at: 0,
					last_used: null,
				},
			],
		}));
		const code = await runResource('keys', ['list', '--site', SITE, ...base], fetchImpl);
		expect(code).toBe(0);
		expect(calls[0]?.url).toBe(`${HOST}/api/keys?site_id=${SITE}`);
		expect(stdout).toContain('ci');
	});

	it('keys list rejects a non-UUID site with exit 1 and no request', async () => {
		const { fetchImpl, calls } = recorder(() => ({}));
		const code = await runResource(
			'keys',
			['list', '--site', 'not-a-uuid', ...base],
			fetchImpl,
		);
		expect(code).toBe(1);
		expect(stderr).toContain('not a valid UUID');
		expect(calls.length).toBe(0);
	});

	it('keys issue prints the plaintext once with a warning and never the admin token', async () => {
		const { fetchImpl, calls } = recorder(() => ({
			id: KEY_ID,
			key: 'clk_deadbeef',
		}));
		const code = await runResource(
			'keys',
			['issue', '--site', SITE, '--label', 'ci', ...base],
			fetchImpl,
		);
		expect(code).toBe(0);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			site_id: SITE,
			label: 'ci',
		});
		expect(stdout).toContain('clk_deadbeef');
		expect(stdout).toContain('shown once');
		expect(stdout).not.toContain(TOKEN);
		expect(stderr).not.toContain(TOKEN);
	});

	it('keys revoke hits the scoped delete URL', async () => {
		const { fetchImpl, calls } = recorder(() => ({ deleted: true }));
		const code = await runResource(
			'keys',
			['revoke', '--id', KEY_ID, '--site', SITE, ...base],
			fetchImpl,
		);
		expect(code).toBe(0);
		expect(calls[0]?.init?.method).toBe('DELETE');
		expect(calls[0]?.url).toBe(`${HOST}/api/keys/${KEY_ID}?site_id=${SITE}`);
	});

	// ── goals ─────────────────────────────────────────────────────────────────
	it('goals create maps --match to match_value and posts', async () => {
		const { fetchImpl, calls } = recorder(() => ({
			goal: {
				id: KEY_ID,
				site_id: SITE,
				name: 'Signup',
				type: 'path',
				match_value: '/done',
				created_at: 0,
			},
		}));
		const code = await runResource(
			'goals',
			[
				'create',
				'--site',
				SITE,
				'--name',
				'Signup',
				'--type',
				'path',
				'--match',
				'/done',
				...base,
			],
			fetchImpl,
		);
		expect(code).toBe(0);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			site_id: SITE,
			name: 'Signup',
			type: 'path',
			match_value: '/done',
		});
	});

	it('goals create rejects an invalid --type with exit 1', async () => {
		const { fetchImpl, calls } = recorder(() => ({}));
		const code = await runResource(
			'goals',
			['create', '--site', SITE, '--name', 'x', '--type', 'bogus', '--match', '/', ...base],
			fetchImpl,
		);
		expect(code).toBe(1);
		expect(stderr).toContain('event');
		expect(calls.length).toBe(0);
	});

	it('goals delete hits the scoped URL', async () => {
		const { fetchImpl, calls } = recorder(() => ({ deleted: true }));
		const code = await runResource(
			'goals',
			['delete', '--id', KEY_ID, '--site', SITE, ...base],
			fetchImpl,
		);
		expect(code).toBe(0);
		expect(calls[0]?.url).toBe(`${HOST}/api/goals/${KEY_ID}?site_id=${SITE}`);
		expect(calls[0]?.init?.method).toBe('DELETE');
	});

	// ── funnels ───────────────────────────────────────────────────────────────
	it('funnels create parses the steps JSON and posts them', async () => {
		const { fetchImpl, calls } = recorder(() => ({
			funnel: {
				id: KEY_ID,
				site_id: SITE,
				name: 'F',
				steps: [],
				created_at: 0,
			},
		}));
		const steps = '[{"type":"path","match_value":"/"},{"type":"path","match_value":"/done"}]';
		const code = await runResource(
			'funnels',
			['create', '--site', SITE, '--name', 'F', '--steps', steps, ...base],
			fetchImpl,
		);
		expect(code).toBe(0);
		expect(JSON.parse(String(calls[0]?.init?.body)).steps).toHaveLength(2);
	});

	it('funnels create rejects invalid JSON steps with exit 1', async () => {
		const { fetchImpl, calls } = recorder(() => ({}));
		const code = await runResource(
			'funnels',
			['create', '--site', SITE, '--name', 'F', '--steps', 'not-json', ...base],
			fetchImpl,
		);
		expect(code).toBe(1);
		expect(stderr).toContain('JSON');
		expect(calls.length).toBe(0);
	});

	// ── experiments ─────────────────────────────────────────────────────────────
	it('experiments create posts flag_key + variants', async () => {
		const { fetchImpl, calls } = recorder(() => ({
			experiment: {
				id: KEY_ID,
				site_id: SITE,
				name: 'E',
				flag_key: 'hero',
				variants: [],
				active: true,
				created_at: 0,
			},
		}));
		const variants = '[{"key":"a","weight":1},{"key":"b","weight":1}]';
		const code = await runResource(
			'experiments',
			[
				'create',
				'--site',
				SITE,
				'--name',
				'E',
				'--flag',
				'hero',
				'--variants',
				variants,
				...base,
			],
			fetchImpl,
		);
		expect(code).toBe(0);
		const body = JSON.parse(String(calls[0]?.init?.body));
		expect(body.flag_key).toBe('hero');
		expect(body.variants).toHaveLength(2);
	});

	it('experiments list renders and exits 0', async () => {
		const { fetchImpl } = recorder(() => ({
			experiments: [
				{
					id: KEY_ID,
					site_id: SITE,
					name: 'E',
					flag_key: 'hero',
					variants: [{ key: 'a', weight: 1 }],
					active: true,
					created_at: 0,
				},
			],
		}));
		const code = await runResource('experiments', ['list', '--site', SITE, ...base], fetchImpl);
		expect(code).toBe(0);
		expect(stdout).toContain('hero');
	});

	// ── auth resolution + failures ────────────────────────────────────────────
	it('reads host + admin token from FACET_HOST / FACET_ADMIN_TOKEN env', async () => {
		vi.stubEnv('FACET_HOST', HOST);
		vi.stubEnv('FACET_ADMIN_TOKEN', TOKEN);
		const { fetchImpl, calls } = recorder(() => ({ sites: [] }));
		const code = await runResource('sites', ['list'], fetchImpl);
		expect(code).toBe(0);
		expect(auth(calls[0]?.init)).toBe(`Bearer ${TOKEN}`);
		expect(stdout).not.toContain(TOKEN);
	});

	it('exits 1 when the admin token is missing', async () => {
		const { fetchImpl, calls } = recorder(() => ({}));
		const code = await runResource('sites', ['list', '--host', HOST], fetchImpl);
		expect(code).toBe(1);
		expect(stderr).toContain('admin token');
		expect(calls.length).toBe(0);
	});

	it('maps a non-2xx API failure to exit 1', async () => {
		const fetchImpl = vi.fn(() => Promise.reject(new Error('unauthorized')));
		const code = await runResource('sites', ['list', ...base], fetchImpl as never);
		expect(code).toBe(1);
		expect(stderr).toContain('unauthorized');
	});

	it('--json emits machine-readable output', async () => {
		const { fetchImpl } = recorder(() => ({
			sites: [{ id: SITE, name: 'B', domain: 'b.dev', created_at: 0 }],
		}));
		const code = await runResource('sites', ['list', '--json', ...base], fetchImpl);
		expect(code).toBe(0);
		expect(JSON.parse(stdout)[0].id).toBe(SITE);
	});

	// ── dispatcher wiring ──────────────────────────────────────────────────────
	it('main() routes resource commands and surfaces their exit code', async () => {
		const code = await main(['goals', 'list']);
		expect(code).toBe(1);
		expect(stderr).toContain('site');
	});
});
