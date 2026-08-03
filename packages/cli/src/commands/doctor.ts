// `facet doctor` — diagnose an existing install: what is configured, what is missing, what to run.
//
// This is the output people paste into a bug report, so it states facts and never secrets: it reports
// that ADMIN_TOKEN exists, never its value, and truncates account/database identifiers.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Site } from '@facet/shared';
import pc from 'picocolors';
import { type FetchJson, adminClient } from '../admin.js';
import { findWrangler, queueExists, secretNames, selectAccount, whoami } from '../lib/cf.js';
import { type Runner, spawnRunner } from '../lib/exec.js';
import { adminToken, findLayout, probeHealth, readLocalState } from '../lib/state.js';
import { fetchJson } from '../util.js';

export interface DoctorDeps {
	run: Runner;
	fetchJson: FetchJson;
	fetchImpl: typeof fetch;
	cwd: string;
	out: (chunk: string) => void;
	err: (chunk: string) => void;
	env: NodeJS.ProcessEnv;
	nodeVersion: string;
}

function defaultDeps(): DoctorDeps {
	return {
		run: spawnRunner,
		fetchJson,
		fetchImpl: fetch,
		cwd: process.cwd(),
		out: (chunk) => process.stdout.write(chunk),
		err: (chunk) => process.stderr.write(chunk),
		env: process.env,
		nodeVersion: process.version,
	};
}

type Status = 'ok' | 'warn' | 'missing' | 'info';

const MARK: Record<Status, string> = {
	ok: pc.green('✓'),
	warn: pc.yellow('!'),
	missing: pc.red('✗'),
	info: pc.dim('·'),
};

/** Shorten an identifier so a pasted report does not carry a full account/database id. */
function truncateId(id: string): string {
	return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export async function runDoctor(
	args: string[],
	overrides: Partial<DoctorDeps> = {},
): Promise<number> {
	const deps: DoctorDeps = { ...defaultDeps(), ...overrides };
	const { values } = parseArgs({
		args,
		options: { config: { type: 'string' }, host: { type: 'string' } },
		allowPositionals: false,
	});

	const lines: string[] = [];
	const next: string[] = [];
	const row = (status: Status, label: string, detail: string) => {
		lines.push(`  ${MARK[status]} ${label.padEnd(16)} ${detail}`);
	};

	const layout = findLayout(deps.cwd, values.config);
	if (!layout.ok) {
		deps.err(
			`${pc.red('✗')} ${layout.error.message}\n  ${pc.bold('→')} ${layout.error.remedy}\n`,
		);
		return 1;
	}
	const local = readLocalState(layout.value);

	deps.out(`\n${pc.bold('facet doctor')}\n\n`);
	row('info', 'node', deps.nodeVersion);
	row('info', 'checkout', local.layout.repoRoot);
	row('info', 'config', local.layout.configPath);
	row(
		local.depsInstalled ? 'ok' : 'missing',
		'dependencies',
		local.depsInstalled ? 'installed' : 'node_modules missing',
	);
	if (!local.depsInstalled) next.push('pnpm install');
	row(
		local.dashboardBuilt ? 'ok' : 'warn',
		'dashboard build',
		local.dashboardBuilt
			? join('apps', 'dashboard', 'dist')
			: 'not built (the Worker serves it as static assets)',
	);
	if (!local.dashboardBuilt) next.push('pnpm --filter @facet/server bundle:assets');

	row('info', 'worker', local.workerName);
	row(
		local.dbId ? 'ok' : 'missing',
		'database id',
		local.dbId
			? `${local.dbName} (${truncateId(local.dbId)})`
			: `${local.dbName} — still the placeholder`,
	);
	if (!local.dbId) next.push('facet init');
	row(
		local.routeIsUpstream ? 'warn' : 'info',
		'route',
		local.routePattern
			? `${local.routePattern}${local.routeIsUpstream ? " — the upstream project's domain; unless that zone is on your account the deploy is rejected" : ''}`
			: '*.workers.dev (no custom domain)',
	);
	if (local.routeIsUpstream)
		next.push(
			'facet init --workers-dev   # or --hostname <your.domain>, unless you own that zone',
		);
	row(
		'info',
		'ingest queue',
		local.queuesEnabled ? (local.queueName ?? 'facet-ingest') : 'disabled (synchronous ingest)',
	);
	row(
		local.hasLocalAdminToken ? 'ok' : 'warn',
		'admin token',
		local.hasLocalAdminToken
			? `present in ${join('apps', 'server', '.dev.vars')} (value never shown)`
			: 'no local copy — set FACET_ADMIN_TOKEN or run `facet init --rotate-admin-token`',
	);

	// ── Cloudflare side. Every probe degrades to a clear "unknown" rather than aborting the report.
	const found = await findWrangler(deps.run, local.layout.repoRoot, local.layout.serverDir);
	if (!found.ok) {
		row('missing', 'wrangler', found.error.message);
		next.push(found.error.remedy);
	} else {
		row('ok', 'wrangler', found.value.version);
		const accounts = await whoami(found.value);
		if (!accounts.ok) {
			row('missing', 'cloudflare', accounts.error.message);
			next.push(accounts.error.remedy);
		} else {
			const account = selectAccount(accounts.value, deps.env.CLOUDFLARE_ACCOUNT_ID);
			if (!account.ok) {
				row('warn', 'cloudflare', account.error.message);
				next.push(account.error.remedy);
			} else {
				row('ok', 'cloudflare', `${account.value.name} (${truncateId(account.value.id)})`);
			}
			if (local.queuesEnabled) {
				const name = local.queueName ?? 'facet-ingest';
				const exists = await queueExists(found.value, name);
				row(
					exists ? 'ok' : 'missing',
					'queue',
					exists ? `${name} exists` : `${name} does not exist — the deploy will fail`,
				);
				if (!exists) next.push('facet init');
			}
			const secrets = await secretNames(found.value);
			if (secrets.ok && secrets.value !== null) {
				const has = secrets.value.includes('ADMIN_TOKEN');
				row(
					has ? 'ok' : 'missing',
					'worker secret',
					has ? 'ADMIN_TOKEN is set' : 'ADMIN_TOKEN is not set',
				);
				if (!has) next.push('facet init');
				const signing = secrets.value.includes('FACET_SIGNING_JWK');
				row(
					'info',
					'signing key',
					signing ? 'FACET_SIGNING_JWK is set' : 'not configured (optional)',
				);
			} else {
				row(
					'warn',
					'worker secret',
					'could not be listed — the Worker may not be deployed yet',
				);
			}
		}
	}

	// ── The deployment itself.
	const host = values.host ?? local.install.host ?? null;
	if (!host) {
		row('warn', 'deployment', 'no deployment recorded — run `facet init`, or pass --host');
		next.push('facet init');
	} else {
		const health = await probeHealth(host, deps.fetchImpl);
		row(health === 'ok' ? 'ok' : 'missing', 'deployment', `${host} — /api/health ${health}`);
		if (health !== 'ok') next.push('facet init   # redeploys and waits for health');
		const token = adminToken(local.layout, deps.env);
		if (health === 'ok' && token) {
			try {
				const { sites } = await adminClient(host, token, deps.fetchJson).get<{
					sites: Site[];
				}>('/api/sites');
				row('ok', 'admin api', `token accepted — ${sites.length} site(s)`);
				for (const site of sites) {
					row('info', 'site', `${site.name} (${site.domain}) ${truncateId(site.id)}`);
				}
				if (sites.length === 0) next.push('facet init   # creates the first site and key');
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				row('missing', 'admin api', `token rejected (${message})`);
				next.push('facet init --rotate-admin-token');
			}
		}
	}

	// A live install with a stale local dashboard build is the classic "why is the UI old" report.
	if (
		local.install.host &&
		!existsSync(join(local.layout.repoRoot, 'apps', 'dashboard', 'dist'))
	) {
		next.push('facet init   # rebuilds and redeploys the dashboard assets');
	}

	deps.out(`${lines.join('\n')}\n`);
	deps.out(`\n${pc.bold('Next steps')}\n`);
	if (next.length === 0) {
		deps.out(`  ${pc.green('Nothing to do — this install looks complete.')}\n`);
	} else {
		for (const item of [...new Set(next)]) deps.out(`  ${pc.cyan('›')} ${item}\n`);
	}
	deps.out(`\n${pc.dim('No secret values are included in this report.')}\n`);
	return 0;
}
