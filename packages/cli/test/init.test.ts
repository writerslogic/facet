// `facet init` end to end against fakes: the happy path, resumption from every intermediate state,
// every failure mode the installer claims to handle, and the secret-discipline guarantees.
//
// The command runner is injected, so these assert the exact argv and stdin without executing wrangler.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import {
	type AdminApi,
	type CloudState,
	type Repo,
	cloudState,
	fakeAdmin,
	fakeRunner,
	makeRepo,
	recordingPrompter,
} from './support.js';

const TOKEN = 'f'.repeat(64);
const DB_ID = '11111111-2222-4333-8444-555555555555';

interface Harness {
	code: number;
	stdout: string;
	stderr: string;
	calls: { command: string; args: string[]; options: { stdin?: string } }[];
	argvText: string;
	repo: Repo;
	cloud: CloudState;
	admin: AdminApi;
	asked: { message: string; fallback: string | boolean }[];
}

async function init(
	args: string[],
	setup: {
		repo?: Repo;
		cloud?: CloudState;
		admin?: AdminApi;
		answers?: Record<string, string | boolean>;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<Harness> {
	const repo = setup.repo ?? makeRepo();
	const cloud = setup.cloud ?? cloudState();
	const admin = setup.admin ?? fakeAdmin(TOKEN);
	const fake = fakeRunner(cloud);
	const { prompter, asked } = recordingPrompter(setup.answers);
	let stdout = '';
	let stderr = '';
	const code = await runInit(args, {
		run: fake.runner,
		prompter,
		fetchJson: admin.fetchJson,
		fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
		cwd: repo.root,
		out: (chunk) => {
			stdout += chunk;
		},
		err: (chunk) => {
			stderr += chunk;
		},
		env: setup.env ?? {},
		randomToken: () => TOKEN,
		sleep: async () => {},
		isTty: false,
	});
	return {
		code,
		stdout,
		stderr,
		calls: fake.calls,
		argvText: fake.argvText(),
		repo,
		cloud,
		admin,
		asked,
	};
}

const BASE = ['--yes', '--workers-dev', '--site-domain', 'example.com', '--site-name', 'Example'];

describe('facet init — happy path from a fresh clone', () => {
	it('creates everything and reports the credentials once', async () => {
		const h = await init(BASE);
		expect(h.stderr).toBe('');
		expect(h.code).toBe(0);

		// Resources created, in order.
		expect(h.argvText).toContain('d1 create facet');
		expect(h.argvText).toContain('queues create facet-ingest');
		expect(h.argvText).toContain('d1 migrations apply facet --remote');
		expect(h.argvText).toContain('deploy --minify');
		expect(h.argvText).toContain('secret put ADMIN_TOKEN');
		expect(h.calls.some((c) => c.command === 'pnpm' && c.args.includes('bundle:assets'))).toBe(
			true,
		);

		// wrangler.jsonc rewritten: real database id, upstream route disabled, comments intact.
		const config = h.repo.config();
		expect(config).toContain(`"database_id": "${DB_ID}"`);
		expect(config).not.toContain('PLACEHOLDER_D1_DATABASE_ID');
		expect(config).toContain('// "routes": [{ "pattern": "facet.writerslogic.com"');
		expect(config).toContain('// Facet Worker config');

		// Site + key created against the deployed Worker, and the key is shown exactly once.
		expect(h.admin.sites).toHaveLength(1);
		expect(h.admin.keys).toHaveLength(1);
		const key = h.admin.issuedKeys[0] as string;
		expect(h.stdout.split(key).length - 1).toBe(1);
		expect(h.stdout).toContain('cannot be retrieved again');
		expect(h.stdout).toContain('https://facet.acme.workers.dev');
		expect(h.stdout).toContain('data-site-id="99999999-8888-4777-8666-555555555555"');
	});

	it('records non-secret resume state in a self-ignoring .facet directory', async () => {
		const h = await init(BASE);
		const state = JSON.parse(readFileSync(h.repo.stateFile(), 'utf8'));
		expect(state.host).toBe('https://facet.acme.workers.dev');
		expect(state.siteId).toBe('99999999-8888-4777-8666-555555555555');
		expect(JSON.stringify(state)).not.toContain(TOKEN);
		expect(readFileSync(join(h.repo.root, '.facet', '.gitignore'), 'utf8')).toBe('*\n');
	});

	it('installs dependencies when node_modules is absent', async () => {
		const h = await init(BASE, { repo: makeRepo({ nodeModules: false }) });
		expect(h.calls.some((c) => c.command === 'pnpm' && c.args[0] === 'install')).toBe(true);
	});

	it('asks only for the hostname, site domain, and site name — each with a default', async () => {
		const h = await init(['--yes']);
		const messages = h.asked.map((a) => a.message);
		expect(messages).toEqual([
			'Hostname to serve Facet on (blank = free *.workers.dev URL)',
			'Domain of the site you want to track',
			'Name for that site',
			'Proceed?',
		]);
		// Every prompt has a default that Enter accepts.
		expect(h.asked.every((a) => a.fallback !== undefined)).toBe(true);
		expect(h.code).toBe(0);
	});

	it('writes the custom hostname into the route when one is given', async () => {
		const h = await init([
			'--yes',
			'--hostname',
			'stats.example.com',
			'--site-domain',
			'example.com',
		]);
		expect(h.repo.config()).toContain('"routes": [{ "pattern": "stats.example.com"');
		expect(h.stdout).toContain('https://stats.example.com');
	});
});

describe('facet init — secret discipline', () => {
	it('never puts a secret in argv or leaks the admin token to stdout', async () => {
		const h = await init(BASE);
		const key = h.admin.issuedKeys[0] as string;

		// argv is world-readable via `ps`: no secret may ever appear there.
		for (const call of h.calls) {
			expect(call.args.join(' ')).not.toContain(TOKEN);
			expect(call.args.join(' ')).not.toContain(key);
		}
		// The admin token is never printed, on either stream.
		expect(h.stdout).not.toContain(TOKEN);
		expect(h.stderr).not.toContain(TOKEN);
		// It reaches wrangler on stdin only.
		const put = h.calls.find((c) => c.args[0] === 'secret' && c.args[1] === 'put');
		expect(put?.options.stdin).toBe(`${TOKEN}\n`);
	});

	it('stores the admin token 0600 in .dev.vars and never persists the API key', async () => {
		const h = await init(BASE);
		expect(readFileSync(h.repo.devVars, 'utf8')).toBe(`ADMIN_TOKEN=${TOKEN}\n`);
		expect(statSync(h.repo.devVars).mode & 0o777).toBe(0o600);
		const key = h.admin.issuedKeys[0] as string;
		for (const file of [h.repo.devVars, h.repo.configPath, h.repo.stateFile()]) {
			expect(readFileSync(file, 'utf8')).not.toContain(key);
		}
	});

	it('sends the admin token in the Authorization header only', async () => {
		const h = await init(BASE);
		expect(h.admin.requests.length).toBeGreaterThan(0);
		expect(h.admin.requests.every((r) => r.authorized)).toBe(true);
		expect(h.admin.requests.every((r) => !r.url.includes(TOKEN))).toBe(true);
	});
});

describe('facet init — resumption', () => {
	it('reuses a database that already exists under the configured name', async () => {
		const cloud = cloudState({ databases: [{ uuid: DB_ID, name: 'facet' }] });
		const h = await init(BASE, { cloud });
		expect(h.argvText).not.toContain('d1 create');
		expect(h.repo.config()).toContain(`"database_id": "${DB_ID}"`);
		expect(h.stdout).toContain('Reusing the existing D1 database');
	});

	it('skips the database step when the configured id already exists remotely', async () => {
		const repo = makeRepo();
		writeFileSync(repo.configPath, repo.config().replace('PLACEHOLDER_D1_DATABASE_ID', DB_ID));
		const cloud = cloudState({ databases: [{ uuid: DB_ID, name: 'facet' }] });
		const h = await init(BASE, { repo, cloud });
		expect(h.argvText).not.toContain('d1 create');
		expect(h.stdout).toContain('Already configured');
	});

	it('--db points the install at another database and renames the binding with it', async () => {
		const cloud = cloudState({ databases: [{ uuid: DB_ID, name: 'analytics' }] });
		const h = await init([...BASE, '--db', 'analytics'], { cloud });
		expect(h.code).toBe(0);
		expect(h.argvText).not.toContain('d1 create');
		// Both fields move together: `d1 migrations apply <name>` resolves the name through the config.
		expect(h.repo.config()).toContain('"database_name": "analytics"');
		expect(h.repo.config()).toContain(`"database_id": "${DB_ID}"`);
		expect(h.argvText).toContain('d1 migrations apply analytics --remote');
	});

	it('does not recreate an existing queue', async () => {
		const h = await init(BASE, { cloud: cloudState({ queues: ['facet-ingest'] }) });
		expect(h.argvText).not.toContain('queues create');
		expect(h.stdout).toContain('Queue already exists');
	});

	it('keeps the deployed admin token when this machine still has a copy', async () => {
		const repo = makeRepo();
		writeFileSync(repo.devVars, `ADMIN_TOKEN=${TOKEN}\n`);
		const h = await init(BASE, {
			repo,
			cloud: cloudState({ secrets: ['ADMIN_TOKEN'] }),
		});
		expect(h.argvText).not.toContain('secret put');
		expect(h.stdout).toContain('this machine has a copy');
		expect(h.code).toBe(0);
	});

	it('rotates the admin token when the Worker has one but this machine does not', async () => {
		const h = await init(BASE, { cloud: cloudState({ secrets: ['ADMIN_TOKEN'] }) });
		expect(h.argvText).toContain('secret put ADMIN_TOKEN');
		expect(h.asked.some((a) => a.message.includes('Generate a new one'))).toBe(true);
		expect(h.code).toBe(0);
	});

	it('stops with a recovery path when rotation is declined', async () => {
		const h = await init(BASE, {
			cloud: cloudState({ secrets: ['ADMIN_TOKEN'] }),
			answers: {
				'The Worker has an ADMIN_TOKEN but this machine has no copy. Generate a new one (the old one stops working)?': false,
			},
		});
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('FACET_ADMIN_TOKEN');
	});

	it('reuses an existing site with the same domain instead of creating a second one', async () => {
		const admin = fakeAdmin(TOKEN, {
			sites: [
				{
					id: '77777777-6666-4555-8444-333333333333',
					name: 'Existing',
					domain: 'example.com',
					created_at: 1,
				},
			],
		});
		const h = await init(BASE, { admin });
		expect(admin.sites).toHaveLength(1);
		expect(h.stdout).toContain('Reusing the existing site');
		expect(
			h.admin.requests.some((r) => r.method === 'POST' && r.url.includes('/api/sites')),
		).toBe(false);
	});

	it('does not issue a second key when the site already has one', async () => {
		const admin = fakeAdmin(TOKEN, {
			sites: [
				{
					id: '77777777-6666-4555-8444-333333333333',
					name: 'Existing',
					domain: 'example.com',
					created_at: 1,
				},
			],
			keys: [
				{
					id: 'key-0',
					site_id: '77777777-6666-4555-8444-333333333333',
					label: null,
					created_at: 1,
				},
			],
		});
		const h = await init(BASE, { admin });
		expect(admin.keys).toHaveLength(1);
		expect(h.stdout).toContain('unrecoverable by design');
		expect(h.stdout).toContain('facet init --new-key');
	});

	it('issues another key on --new-key', async () => {
		const admin = fakeAdmin(TOKEN, {
			sites: [
				{
					id: '77777777-6666-4555-8444-333333333333',
					name: 'Existing',
					domain: 'example.com',
					created_at: 1,
				},
			],
			keys: [
				{
					id: 'key-0',
					site_id: '77777777-6666-4555-8444-333333333333',
					label: null,
					created_at: 1,
				},
			],
		});
		const h = await init([...BASE, '--new-key'], { admin });
		expect(admin.keys).toHaveLength(2);
		expect(h.stdout).toContain(admin.issuedKeys[0] as string);
	});

	it('a second full run is a no-op: no database, queue, site, or key is duplicated', async () => {
		const repo = makeRepo();
		const cloud = cloudState();
		const admin = fakeAdmin(TOKEN);
		const first = await init(BASE, { repo, cloud, admin });
		expect(first.code).toBe(0);
		const second = await init(BASE, { repo, cloud, admin });
		expect(second.code).toBe(0);
		expect(cloud.databases).toHaveLength(1);
		expect(cloud.queues).toEqual(['facet-ingest']);
		expect(admin.sites).toHaveLength(1);
		expect(admin.keys).toHaveLength(1);
		expect(second.argvText).not.toContain('d1 create');
		expect(second.argvText).not.toContain('queues create');
		expect(second.argvText).not.toContain('secret put');
	});
});

describe('facet init — failure modes', () => {
	it('wrangler is not installed', async () => {
		const h = await init(BASE, { cloud: cloudState({ missing: true }) });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('wrangler was not found');
		expect(h.stderr).toContain('pnpm install');
	});

	it('wrangler is too old', async () => {
		const h = await init(BASE, { cloud: cloudState({ version: '3.90.0' }) });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('too old');
		expect(h.stderr).toContain('wrangler@4');
	});

	it('not logged in to Cloudflare', async () => {
		const cloud = cloudState({
			failures: {
				whoami: {
					code: 1,
					stderr: 'In a non-interactive environment, it is necessary to set a CLOUDFLARE_API_TOKEN',
				},
			},
		});
		const h = await init(BASE, { cloud });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('not logged in');
		expect(h.stderr).toContain('wrangler login');
	});

	it('login has no account', async () => {
		const h = await init(BASE, { cloud: cloudState({ accounts: [] }) });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('no account attached');
	});

	it('several accounts and no CLOUDFLARE_ACCOUNT_ID', async () => {
		const cloud = cloudState({
			accounts: [
				{ id: 'a-1', name: 'Personal' },
				{ id: 'a-2', name: 'Work' },
			],
		});
		const h = await init(BASE, { cloud });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('CLOUDFLARE_ACCOUNT_ID');
		expect(h.stderr).toContain('Work (a-2)');
	});

	it('several accounts with CLOUDFLARE_ACCOUNT_ID set proceeds', async () => {
		const cloud = cloudState({
			accounts: [
				{ id: 'a-1', name: 'Personal' },
				{ id: 'a-2', name: 'Work' },
			],
		});
		const h = await init(BASE, { cloud, env: { CLOUDFLARE_ACCOUNT_ID: 'a-2' } });
		expect(h.code).toBe(0);
		expect(h.stdout).toContain('Work');
	});

	it('D1 creation refused by the plan limit', async () => {
		const cloud = cloudState({
			failures: {
				'd1 create': {
					code: 1,
					stderr: 'You have exceeded the maximum number of databases on your plan.',
				},
			},
		});
		const h = await init(BASE, { cloud });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('maximum number of databases');
		expect(h.stderr).toContain('facet init --db <existing-name>');
		// Nothing was written to the config on the way out.
		expect(h.repo.config()).toContain('PLACEHOLDER_D1_DATABASE_ID');
	});

	it('Queues unavailable on the plan: offers to disable it and carries on', async () => {
		const cloud = cloudState({
			failures: {
				'queues create': { code: 1, stderr: 'Queues requires a paid plan subscription' },
			},
		});
		const h = await init(BASE, { cloud });
		expect(h.code).toBe(0);
		expect(h.repo.config()).toContain('// "queues": {');
		expect(h.stdout).toContain('Commented the queues block out');
		expect(h.argvText).toContain('deploy --minify');
	});

	it('Queues unavailable and the operator declines: stops with the plan explained', async () => {
		const cloud = cloudState({
			failures: {
				'queues create': { code: 1, stderr: 'Queues requires a paid plan subscription' },
			},
		});
		const h = await init(BASE, {
			cloud,
			answers: {
				'Continue without Cloudflare Queues (ingest writes synchronously)?': false,
			},
		});
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('Workers Paid plan');
	});

	it('deploy rejected because the zone is not on the account', async () => {
		const cloud = cloudState({
			failures: {
				deploy: {
					code: 1,
					stderr: 'Could not find zone for stats.example.com [code: 10077]',
				},
			},
		});
		const h = await init(
			['--yes', '--hostname', 'stats.example.com', '--site-domain', 'example.com'],
			{
				cloud,
			},
		);
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('not on this Cloudflare account');
		expect(h.stderr).toContain('--workers-dev');
	});

	it('deploy rejected for any other reason still says how to resume', async () => {
		const cloud = cloudState({
			failures: { deploy: { code: 1, stderr: 'Script startup exceeded CPU time limit' } },
		});
		const h = await init(BASE, { cloud });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('Script startup exceeded CPU time limit');
		expect(h.stderr).toContain('Resume with: facet init');
	});

	it('migrations failure explains the state the database is left in', async () => {
		const cloud = cloudState({
			failures: { 'd1 migrations': { code: 1, stderr: 'near "SELCT": syntax error' } },
		});
		const h = await init(BASE, { cloud });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('syntax error');
		expect(h.stderr).toContain('already-applied migrations are skipped');
	});

	it('a failed key issuance exits nonzero instead of claiming success', async () => {
		const repo = makeRepo();
		const admin = fakeAdmin(TOKEN);
		let stdout = '';
		let stderr = '';
		const code = await runInit(BASE, {
			run: fakeRunner(cloudState()).runner,
			prompter: recordingPrompter().prompter,
			// Everything works except issuing the key — the one step whose success is "no value".
			fetchJson: (async (url: string, requestInit?: RequestInit) => {
				if ((requestInit?.method ?? 'GET') === 'POST' && url.includes('/api/keys')) {
					throw new Error('internal_error');
				}
				return admin.fetchJson(url, requestInit);
			}) as typeof admin.fetchJson,
			fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
			cwd: repo.root,
			out: (chunk) => {
				stdout += chunk;
			},
			err: (chunk) => {
				stderr += chunk;
			},
			env: {},
			randomToken: () => TOKEN,
			sleep: async () => {},
			isTty: false,
		});
		expect(code).toBe(1);
		expect(stderr).toContain('issuing the API key failed');
		expect(stdout).not.toContain('Facet is live');
	});

	it('dashboard build failure blocks the deploy with an explanation', async () => {
		const repo = makeRepo();
		const cloud = cloudState();
		const fake = fakeRunner(cloud);
		let stderr = '';
		const code = await runInit(BASE, {
			run: async (command, args, options) =>
				command === 'pnpm' && args.includes('bundle:assets')
					? { code: 1, stdout: '', stderr: 'vite build failed' }
					: fake.runner(command, args, options),
			prompter: recordingPrompter().prompter,
			fetchJson: fakeAdmin(TOKEN).fetchJson,
			fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch,
			cwd: repo.root,
			out: () => {},
			err: (chunk) => {
				stderr += chunk;
			},
			env: {},
			randomToken: () => TOKEN,
			sleep: async () => {},
			isTty: false,
		});
		expect(code).toBe(1);
		expect(stderr).toContain('Building the dashboard failed');
		expect(fake.argvText()).not.toContain('deploy');
	});

	it('deployment never becomes healthy', async () => {
		const repo = makeRepo();
		let stderr = '';
		const code = await runInit(BASE, {
			run: fakeRunner(cloudState()).runner,
			prompter: recordingPrompter().prompter,
			fetchJson: fakeAdmin(TOKEN).fetchJson,
			fetchImpl: (async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch,
			cwd: repo.root,
			out: () => {},
			err: (chunk) => {
				stderr += chunk;
			},
			env: {},
			randomToken: () => TOKEN,
			sleep: async () => {},
			isTty: false,
		});
		expect(code).toBe(1);
		expect(stderr).toContain('did not answer /api/health');
		expect(stderr).toContain('Resume with: facet init');
	});

	it('admin token rejected by the deployment points at rotation', async () => {
		const admin = fakeAdmin('some-other-token');
		const h = await init(BASE, { admin });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('rejected the admin token');
		expect(h.stderr).toContain('--rotate-admin-token');
	});

	it('a configured database id that the account does not own is never silently replaced', async () => {
		const repo = makeRepo();
		writeFileSync(
			repo.configPath,
			repo
				.config()
				.replace('PLACEHOLDER_D1_DATABASE_ID', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
		);
		const h = await init(BASE, { repo });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('which this Cloudflare account does not have');
		expect(h.stderr).toContain('--force-db-id');
		expect(h.repo.config()).toContain('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
	});

	it('--force-db-id replaces a stale id', async () => {
		const repo = makeRepo();
		writeFileSync(
			repo.configPath,
			repo
				.config()
				.replace('PLACEHOLDER_D1_DATABASE_ID', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
		);
		const h = await init([...BASE, '--force-db-id'], { repo });
		expect(h.code).toBe(0);
		expect(h.repo.config()).toContain(`"database_id": "${DB_ID}"`);
	});

	it('run outside a checkout', async () => {
		const h = await init(BASE, { repo: { ...makeRepo(), root: '/' } as Repo });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('No apps/server/wrangler.jsonc found');
		expect(h.stderr).toContain('git clone');
	});

	it('declining the plan changes nothing', async () => {
		const h = await init(['--site-domain', 'example.com'], { answers: { 'Proceed?': false } });
		expect(h.code).toBe(0);
		expect(h.argvText).not.toContain('d1 create');
		expect(h.repo.config()).toContain('PLACEHOLDER_D1_DATABASE_ID');
	});
});

describe('facet init --dry-run', () => {
	it('prints the plan and changes nothing at all', async () => {
		const h = await init(['--dry-run', '--workers-dev', '--site-domain', 'example.com']);
		expect(h.code).toBe(0);
		expect(h.stdout).toContain('dry run');
		expect(h.stdout).toContain('would run: wrangler d1 create facet');
		expect(h.stdout).toContain('would run: wrangler deploy --minify');
		expect(h.stdout).toContain('would run: wrangler secret put ADMIN_TOKEN');

		// Read-only probes only: nothing was created, written, or deployed.
		for (const forbidden of ['d1 create', 'queues create', 'deploy', 'secret put']) {
			expect(h.argvText).not.toContain(forbidden);
		}
		expect(h.calls.every((c) => c.command !== 'pnpm')).toBe(true);
		expect(h.repo.config()).toContain('PLACEHOLDER_D1_DATABASE_ID');
		expect(existsSync(h.repo.devVars)).toBe(false);
		expect(existsSync(h.repo.stateFile())).toBe(false);
		expect(h.admin.sites).toHaveLength(0);
		expect(h.admin.requests).toHaveLength(0);
	});
});
