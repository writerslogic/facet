// Test doubles for the installer: a scriptable command runner that records every argv and stdin, a
// tiny in-memory admin API, and a temp checkout. Nothing here ever spawns a process or opens a socket.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunOptions, RunResult, Runner } from '../src/lib/exec.js';
import type { Prompter } from '../src/lib/prompt.js';

export interface Call {
	command: string;
	args: string[];
	options: RunOptions;
}

/** Mutable Cloudflare-side state the fake wrangler answers from, so resumption is modelled honestly. */
export interface CloudState {
	version: string;
	accounts: { id: string; name: string }[];
	databases: { uuid: string; name: string }[];
	queues: string[];
	/** null models a Worker that has never been deployed (`secret list` fails). */
	secrets: string[] | null;
	deployUrl: string;
	/** Force a specific subcommand to fail: key is a prefix of the joined argv. */
	failures: Record<string, { code: number; stderr: string }>;
	/** Simulate the wrangler binary not being installed at all. */
	missing?: boolean;
}

export function cloudState(overrides: Partial<CloudState> = {}): CloudState {
	return {
		version: '4.112.0',
		accounts: [{ id: 'acc-1234567890', name: 'Acme' }],
		databases: [],
		queues: [],
		secrets: null,
		deployUrl: 'https://facet.acme.workers.dev',
		failures: {},
		...overrides,
	};
}

export interface FakeRunner {
	runner: Runner;
	calls: Call[];
	/** Every argv, joined — the surface a secret must never appear on. */
	argvText(): string;
}

const OK = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

export function fakeRunner(state: CloudState): FakeRunner {
	const calls: Call[] = [];
	const runner: Runner = async (command, args, options = {}) => {
		calls.push({ command, args, options });
		const key = args.join(' ');
		for (const [prefix, failure] of Object.entries(state.failures)) {
			if (key.startsWith(prefix))
				return { code: failure.code, stdout: '', stderr: failure.stderr };
		}
		if (command === 'pnpm') return OK('');
		if (state.missing) return { code: 127, stdout: '', stderr: 'spawn wrangler ENOENT' };

		if (key === '--version') return OK(`wrangler ${state.version}`);
		if (key === 'whoami --json') {
			return state.accounts.length === 0
				? OK('{"accounts":[]}')
				: OK(JSON.stringify({ accounts: state.accounts }));
		}
		if (key === 'd1 list --json') return OK(JSON.stringify(state.databases));
		if (args[0] === 'd1' && args[1] === 'info') {
			const found = state.databases.find((db) => db.uuid === args[2] || db.name === args[2]);
			return found ? OK(JSON.stringify(found)) : { code: 1, stdout: '', stderr: 'not found' };
		}
		if (args[0] === 'd1' && args[1] === 'create') {
			const name = args[2] ?? 'facet';
			state.databases.push({ uuid: '11111111-2222-4333-8444-555555555555', name });
			return OK(`✅ Created DB ${name}`);
		}
		if (args[0] === 'd1' && args[1] === 'migrations') return OK('No migrations to apply!');
		if (args[0] === 'queues' && args[1] === 'info') {
			return state.queues.includes(args[2] ?? '')
				? OK('queue info')
				: { code: 1, stdout: '', stderr: 'Queue not found' };
		}
		if (args[0] === 'queues' && args[1] === 'create') {
			state.queues.push(args[2] ?? '');
			return OK('Created queue');
		}
		if (key === 'secret list --format json') {
			return state.secrets === null
				? { code: 1, stdout: '', stderr: 'workers.api.error.script_not_found' }
				: OK(JSON.stringify(state.secrets.map((name) => ({ name, type: 'secret_text' }))));
		}
		if (args[0] === 'secret' && args[1] === 'put') {
			state.secrets = [...(state.secrets ?? []), args[2] ?? ''];
			return OK(`Success! Uploaded secret ${args[2]}`);
		}
		if (args[0] === 'deploy') {
			state.secrets = state.secrets ?? [];
			return OK(`Deployed facet\n  ${state.deployUrl}\nCurrent Version ID: abc`);
		}
		return OK('');
	};
	return { runner, calls, argvText: () => calls.map((c) => c.args.join(' ')).join('\n') };
}

export interface AdminApi {
	sites: { id: string; name: string; domain: string; created_at: number }[];
	keys: { id: string; site_id: string; label: string | null; created_at: number }[];
	requests: { method: string; url: string; authorized: boolean }[];
	/** Force every call to fail with this error code (e.g. 'invalid_admin_token'). */
	reject?: string;
	fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>;
	/** The plaintext the fake issued, so a test can assert where it did and did not appear. */
	issuedKeys: string[];
}

export function fakeAdmin(token: string, seed: Partial<AdminApi> = {}): AdminApi {
	const api: AdminApi = {
		sites: seed.sites ?? [],
		keys: seed.keys ?? [],
		requests: [],
		reject: seed.reject,
		issuedKeys: [],
		fetchJson: async <T>(url: string, init?: RequestInit): Promise<T> => {
			const method = init?.method ?? 'GET';
			const headers = (init?.headers ?? {}) as Record<string, string>;
			const authorized = headers.Authorization === `Bearer ${token}`;
			api.requests.push({ method, url, authorized });
			if (api.reject) throw new Error(api.reject);
			if (!authorized) throw new Error('invalid_admin_token');
			const path = url.slice(url.indexOf('/api/'));
			if (method === 'GET' && path.startsWith('/api/sites')) {
				return { sites: api.sites } as T;
			}
			if (method === 'POST' && path.startsWith('/api/sites')) {
				const body = JSON.parse(String(init?.body)) as { name: string; domain: string };
				const site = {
					id: '99999999-8888-4777-8666-555555555555',
					name: body.name,
					domain: body.domain,
					created_at: 1,
				};
				api.sites.push(site);
				return { site } as T;
			}
			if (method === 'GET' && path.startsWith('/api/keys')) {
				const siteId = new URL(url).searchParams.get('site_id');
				return { keys: api.keys.filter((k) => k.site_id === siteId) } as T;
			}
			if (method === 'POST' && path.startsWith('/api/keys')) {
				const body = JSON.parse(String(init?.body)) as { site_id: string; label?: string };
				const id = `key-${api.keys.length + 1}`;
				api.keys.push({
					id,
					site_id: body.site_id,
					label: body.label ?? null,
					created_at: 1,
				});
				const plaintext = `clk_${'a'.repeat(64)}`;
				api.issuedKeys.push(plaintext);
				return { id, key: plaintext } as T;
			}
			throw new Error(`404 ${method} ${path}`);
		},
	};
	return api;
}

/** A prompter that always takes the default, recording every question and its default. */
export function recordingPrompter(answers: Record<string, string | boolean> = {}) {
	const asked: { message: string; fallback: string | boolean }[] = [];
	const prompter: Prompter = {
		async text(message, fallback) {
			asked.push({ message, fallback });
			const scripted = answers[message];
			return typeof scripted === 'string' ? scripted : fallback;
		},
		async confirm(message, fallback) {
			asked.push({ message, fallback });
			const scripted = answers[message];
			return typeof scripted === 'boolean' ? scripted : fallback;
		},
		close() {},
	};
	return { prompter, asked };
}

export const REAL_CONFIG = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'apps',
	'server',
	'wrangler.jsonc',
);

/**
 * The wrangler.jsonc a fresh clone gets: the real shipped config with the database id normalised back
 * to the placeholder and exactly one active `routes` line pointing at the upstream domain — the worst
 * case the installer has to fix. Built by rewriting rather than by assuming, so a working copy that
 * already carries a live id (the file is tracked with skip-worktree) still produces a stable fixture.
 */
export function freshConfig(): string {
	const lines = readFileSync(REAL_CONFIG, 'utf8')
		.replace(/"database_id"\s*:\s*"[^"]*"/, '"database_id": "PLACEHOLDER_D1_DATABASE_ID"')
		.split('\n')
		.filter((line) => !/^\s*(\/\/\s*)?"routes"\s*:/.test(line));
	const nameIdx = lines.findIndex((line) => line.trimStart().startsWith('"name"'));
	lines.splice(
		nameIdx + 1,
		0,
		'  "routes": [{ "pattern": "facet.writerslogic.com", "custom_domain": true }],',
	);
	return lines.join('\n');
}

export interface Repo {
	root: string;
	configPath: string;
	devVars: string;
	config(): string;
	stateFile(): string;
}

/** A temp checkout that looks enough like the real one for detection to work. */
export function makeRepo(options: { config?: string; nodeModules?: boolean } = {}): Repo {
	const root = mkdtempSync(join(tmpdir(), 'facet-repo-'));
	const serverDir = join(root, 'apps', 'server');
	mkdirSync(serverDir, { recursive: true });
	if (options.nodeModules !== false) mkdirSync(join(root, 'node_modules'), { recursive: true });
	const configPath = join(serverDir, 'wrangler.jsonc');
	writeFileSync(configPath, options.config ?? freshConfig());
	return {
		root,
		configPath,
		devVars: join(serverDir, '.dev.vars'),
		config: () => readFileSync(configPath, 'utf8'),
		stateFile: () => join(root, '.facet', 'install.json'),
	};
}
