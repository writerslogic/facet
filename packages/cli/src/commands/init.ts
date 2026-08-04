// `facet init` — the one command that takes a fresh clone to a live deployment with a site and key.
//
// Design rules, in order of importance:
//  1. Determine everything determinable. Ask only for what no machine can know (what the site is
//     called, which hostname you own) and give every prompt a default that Enter accepts.
//  2. Re-detect state on every run instead of tracking progress. An interrupted install is resumed by
//     running the same command again: existing resources are reused, never duplicated.
//  3. Secrets travel on stdin and nowhere else. The admin token is never printed, never in argv, and
//     lands only in .dev.vars at mode 0600. An issued API key is printed exactly once, unrecoverable
//     by design, and never persisted.

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ApiKeyRecord, Site } from '@facet/shared';
import pc from 'picocolors';
import { type FetchJson, adminClient, normalizeHost } from '../admin.js';
import {
	type CfError,
	type CfResult,
	type Wrangler,
	d1Create,
	d1Find,
	d1InfoById,
	deploy,
	findWrangler,
	migrationsApply,
	queueCreate,
	queueExists,
	secretNames,
	secretPut,
	selectAccount,
	whoami,
} from '../lib/cf.js';
import { type Runner, spawnRunner } from '../lib/exec.js';
import { type Prompter, autoPrompter, ttyPrompter } from '../lib/prompt.js';
import { type LocalState, findLayout, probeHealth, readLocalState } from '../lib/state.js';
import { adminToken as readAdminToken } from '../lib/state.js';
import { writeDevVar, writeInstallState } from '../lib/store.js';
import { type Ui, createUi } from '../lib/ui.js';
import {
	commentOutQueues,
	setDatabaseId,
	setDatabaseName,
	setRoutePattern,
} from '../lib/wranglerConfig.js';
import { fetchJson } from '../util.js';

const TOTAL_STEPS = 10;
const HEALTH_ATTEMPTS = 10;
const HEALTH_INTERVAL_MS = 3000;

export interface InitDeps {
	run: Runner;
	prompter?: Prompter;
	fetchJson: FetchJson;
	fetchImpl: typeof fetch;
	cwd: string;
	out: (chunk: string) => void;
	err: (chunk: string) => void;
	env: NodeJS.ProcessEnv;
	/** Injectable so a test can assert the exact token bytes never leave stdin. */
	randomToken: () => string;
	sleep: (ms: number) => Promise<void>;
	isTty: boolean;
}

function defaultDeps(): InitDeps {
	return {
		run: spawnRunner,
		fetchJson,
		fetchImpl: fetch,
		cwd: process.cwd(),
		out: (chunk) => process.stdout.write(chunk),
		err: (chunk) => process.stderr.write(chunk),
		env: process.env,
		randomToken: () => randomBytes(32).toString('hex'),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		isTty: Boolean(process.stdin.isTTY),
	};
}

interface Options {
	config?: string;
	db?: string;
	host?: string;
	siteName?: string;
	siteDomain?: string;
	hostname?: string;
	workersDev: boolean;
	yes: boolean;
	dryRun: boolean;
	newKey: boolean;
	rotateAdminToken: boolean;
	forceDbId: boolean;
}

function parse(args: string[]): Options {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: 'string' },
			db: { type: 'string' },
			host: { type: 'string' },
			'site-name': { type: 'string' },
			'site-domain': { type: 'string' },
			hostname: { type: 'string' },
			'workers-dev': { type: 'boolean' },
			yes: { type: 'boolean', short: 'y' },
			'dry-run': { type: 'boolean' },
			'new-key': { type: 'boolean' },
			'rotate-admin-token': { type: 'boolean' },
			'force-db-id': { type: 'boolean' },
		},
		allowPositionals: false,
	});
	return {
		config: values.config,
		db: values.db,
		host: values.host,
		siteName: values['site-name'],
		siteDomain: values['site-domain'],
		hostname: values.hostname,
		workersDev: Boolean(values['workers-dev']),
		yes: Boolean(values.yes),
		dryRun: Boolean(values['dry-run']),
		newKey: Boolean(values['new-key']),
		rotateAdminToken: Boolean(values['rotate-admin-token']),
		forceDbId: Boolean(values['force-db-id']),
	};
}

/** Print a failure as {what happened, what to do, how to resume} and exit nonzero. */
function bail(ui: Ui, error: CfError): number {
	ui.blank();
	ui.fail(error.message);
	ui.err(`  ${pc.bold('→')} ${error.remedy}\n`);
	if (error.resume) ui.err(`  ${pc.dim(`Resume with: ${error.resume}`)}\n`);
	return 1;
}

/** "example.com" → "Example". A default the operator can accept without thinking. */
function siteNameFromDomain(domain: string): string {
	const label = domain.replace(/^www\./, '').split('.')[0] ?? domain;
	return label.charAt(0).toUpperCase() + label.slice(1);
}

interface Ctx {
	ui: Ui;
	deps: InitDeps;
	opts: Options;
	prompter: Prompter;
	local: LocalState;
	wrangler: Wrangler;
	/** Bumped by each step so the [n/10] counter stays honest. */
	stepIndex: number;
}

function writeConfig(ctx: Ctx, source: string): void {
	writeFileSync(ctx.local.layout.configPath, source);
	ctx.local.source = source;
}

// ── steps ──────────────────────────────────────────────────────────────────

async function stepDependencies(ctx: Ctx): Promise<CfResult<true>> {
	const { ui, local, deps } = ctx;
	ui.step(ctx.stepIndex, TOTAL_STEPS, 'Workspace dependencies');
	if (local.depsInstalled) {
		ui.skip('node_modules present — skipping install.');
		return { ok: true, value: true };
	}
	if (ctx.opts.dryRun) {
		ui.info('would run: pnpm install');
		return { ok: true, value: true };
	}
	ui.info('Installing workspace dependencies (pnpm install)…');
	const result = await deps.run('pnpm', ['install'], {
		cwd: local.layout.repoRoot,
		stream: true,
	});
	if (result.code !== 0) {
		return {
			ok: false,
			error: {
				code: 'install_failed',
				message: `\`pnpm install\` failed (exit ${result.code}).`,
				remedy: 'Check the output above. Facet needs Node 22+ and pnpm 11; `corepack enable` installs the pinned pnpm.',
				resume: 'facet init',
			},
		};
	}
	ui.ok('Dependencies installed.');
	return { ok: true, value: true };
}

async function stepDatabase(ctx: Ctx): Promise<CfResult<string>> {
	const { ui, local, wrangler, opts } = ctx;
	const name = opts.db ?? local.dbName;
	ui.step(ctx.stepIndex, TOTAL_STEPS, `D1 database "${name}"`);

	if (local.dbId) {
		const info = await d1InfoById(wrangler, local.dbId);
		if (info.ok && info.value) {
			ui.skip(
				`Already configured (id ${local.dbId.slice(0, 8)}…) and present on the account.`,
			);
			return { ok: true, value: local.dbId };
		}
		if (!opts.forceDbId) {
			return {
				ok: false,
				error: {
					code: 'db_id_stale',
					message: `wrangler.jsonc points at database ${local.dbId}, which this Cloudflare account does not have.`,
					remedy: 'You are probably signed in to a different account than the one that owns it. Either `wrangler login` to the right account, or re-run with `facet init --force-db-id` to create a fresh database and overwrite the id.',
					resume: 'facet init',
				},
			};
		}
		ui.warn(
			'The configured database id does not exist on this account; --force-db-id was given.',
		);
	}

	const existing = await d1Find(wrangler, name);
	if (!existing.ok) return existing;
	let id = existing.value?.uuid ?? null;
	if (id) {
		ui.info(`Reusing the existing D1 database "${name}".`);
	} else if (opts.dryRun) {
		ui.info(`would run: wrangler d1 create ${name}`);
		return { ok: true, value: 'PENDING' };
	} else {
		const created = await d1Create(wrangler, name);
		if (!created.ok) return created;
		id = created.value.uuid;
		ui.ok(`Created D1 database "${name}".`);
	}

	if (ctx.opts.dryRun) {
		ui.info(`would write database_id into ${local.layout.configPath}`);
		return { ok: true, value: id };
	}
	const edit = setDatabaseId(local.source, id, opts.forceDbId);
	if (!edit.ok) {
		return {
			ok: false,
			error: {
				code: 'config_write_refused',
				message: edit.reason,
				remedy: 'Re-run with `facet init --force-db-id` only if you are sure the existing id is wrong — pointing a live deployment at the wrong database loses data.',
				resume: 'facet init',
			},
		};
	}
	writeConfig(ctx, edit.source);
	// `wrangler d1 migrations apply <name>` resolves the name through this config, so --db pointing at
	// a differently-named database has to rename the binding too or the migration step fails.
	if (name !== local.dbName) {
		const renamed = setDatabaseName(local.source, name);
		if (!renamed.ok) {
			return {
				ok: false,
				error: {
					code: 'config_write_failed',
					message: renamed.reason,
					remedy: `Set "database_name": "${name}" in ${local.layout.configPath} by hand, then re-run.`,
					resume: 'facet init',
				},
			};
		}
		writeConfig(ctx, renamed.source);
		local.dbName = name;
	}
	ui.ok(`Wrote database_id into ${local.layout.configPath}.`);
	return { ok: true, value: id };
}

async function stepQueue(ctx: Ctx): Promise<CfResult<true>> {
	const { ui, local, wrangler, prompter, opts } = ctx;
	const name = local.queueName ?? 'facet-ingest';
	ui.step(ctx.stepIndex, TOTAL_STEPS, `Ingest queue "${name}"`);
	if (!local.queuesEnabled) {
		ui.skip('The queues binding is disabled in wrangler.jsonc — ingest writes synchronously.');
		return { ok: true, value: true };
	}
	if (await queueExists(wrangler, name)) {
		ui.skip('Queue already exists.');
		return { ok: true, value: true };
	}
	if (opts.dryRun) {
		ui.info(`would run: wrangler queues create ${name}`);
		return { ok: true, value: true };
	}
	const created = await queueCreate(wrangler, name);
	if (created.ok) {
		ui.ok(created.value === 'created' ? 'Queue created.' : 'Queue already existed.');
		return { ok: true, value: true };
	}
	if (created.error.code !== 'queue_plan_required') return created;

	// Free plan: Queues is a paid feature, but Facet only uses it to move D1 writes off the hot path.
	// Disabling the binding keeps the deployment working, so offer that rather than dead-ending.
	ui.warn(created.error.message);
	const disable = await prompter.confirm(
		'Continue without Cloudflare Queues (ingest writes synchronously)?',
		true,
	);
	if (!disable) return created;
	const edit = commentOutQueues(local.source);
	if (!edit.ok) {
		return {
			ok: false,
			error: {
				code: 'queue_disable_failed',
				message: edit.reason,
				remedy: 'Remove the `queues` block from apps/server/wrangler.jsonc by hand, then re-run.',
				resume: 'facet init',
			},
		};
	}
	writeConfig(ctx, edit.source);
	local.queuesEnabled = false;
	ui.ok('Commented the queues block out of wrangler.jsonc.');
	return { ok: true, value: true };
}

async function stepHostname(ctx: Ctx, hostname: string | null): Promise<CfResult<true>> {
	const { ui, local, opts } = ctx;
	ui.step(ctx.stepIndex, TOTAL_STEPS, 'Public hostname');
	const current = local.routePattern;
	if (current === hostname) {
		ui.skip(
			hostname
				? `Route already set to ${hostname}.`
				: 'No custom domain — using the *.workers.dev URL.',
		);
		return { ok: true, value: true };
	}
	if (opts.dryRun) {
		ui.info(
			hostname
				? `would set the route to ${hostname}`
				: 'would comment out the custom-domain route',
		);
		return { ok: true, value: true };
	}
	const edit = setRoutePattern(local.source, hostname);
	if (!edit.ok) {
		return {
			ok: false,
			error: {
				code: 'route_edit_failed',
				message: edit.reason,
				remedy: 'Edit the `routes` entry in apps/server/wrangler.jsonc by hand, then re-run.',
				resume: 'facet init',
			},
		};
	}
	writeConfig(ctx, edit.source);
	ui.ok(
		hostname
			? `Route set to ${hostname} (Cloudflare provisions the DNS record and certificate on deploy).`
			: 'Custom-domain route disabled — deploying to the free *.workers.dev URL.',
	);
	return { ok: true, value: true };
}

async function stepMigrations(ctx: Ctx, dbName: string): Promise<CfResult<true>> {
	const { ui, wrangler, opts } = ctx;
	ui.step(ctx.stepIndex, TOTAL_STEPS, 'Database migrations');
	if (opts.dryRun) {
		ui.info(`would run: wrangler d1 migrations apply ${dbName} --remote`);
		return { ok: true, value: true };
	}
	const applied = await migrationsApply(wrangler, dbName);
	if (!applied.ok) return applied;
	ui.ok('Migrations applied.');
	return { ok: true, value: true };
}

async function stepBuild(ctx: Ctx): Promise<CfResult<true>> {
	const { ui, local, deps, opts } = ctx;
	ui.step(ctx.stepIndex, TOTAL_STEPS, 'Dashboard build');
	if (opts.dryRun) {
		ui.info('would run: pnpm --filter @facet/server bundle:assets');
		return { ok: true, value: true };
	}
	const result = await deps.run('pnpm', ['--filter', '@facet/server', 'bundle:assets'], {
		cwd: local.layout.repoRoot,
		stream: true,
	});
	if (result.code !== 0) {
		return {
			ok: false,
			error: {
				code: 'build_failed',
				message: `Building the dashboard failed (exit ${result.code}).`,
				remedy: 'The Worker serves the dashboard from apps/dashboard/dist, so the deploy cannot proceed. Check the build output above; `pnpm install` at the repo root fixes most dependency errors.',
				resume: 'facet init',
			},
		};
	}
	ui.ok('Dashboard and tracker built.');
	return { ok: true, value: true };
}

async function stepDeploy(ctx: Ctx, hostname: string | null): Promise<CfResult<string>> {
	const { ui, local, opts, deps } = ctx;
	ui.step(ctx.stepIndex, TOTAL_STEPS, 'Deploy the Worker');
	if (opts.dryRun) {
		ui.info('would run: wrangler deploy --minify');
		// The workers.dev URL is only known once wrangler prints it, so a dry run shows the best guess:
		// the chosen hostname, else whatever the last real install recorded.
		return {
			ok: true,
			value:
				opts.host ??
				(hostname ? `https://${hostname}` : null) ??
				local.install.host ??
				'https://<worker>.workers.dev',
		};
	}
	const result = await deploy(ctx.wrangler);
	if (!result.ok) return result;
	const host =
		opts.host ??
		(hostname ? `https://${hostname}` : result.value.url) ??
		local.install.host ??
		null;
	if (!host) {
		return {
			ok: false,
			error: {
				code: 'host_unknown',
				message: 'The deploy succeeded but wrangler did not print a URL for it.',
				remedy: 'Find the Worker URL in the Cloudflare dashboard and re-run with `facet init --host https://your-worker.workers.dev`; everything already done is detected and skipped.',
				resume: 'facet init --host <url>',
			},
		};
	}
	// Validated before it is persisted: `.facet/install.json` is what every later run reads back as the
	// destination for the admin token, so a bad `--host` must fail here rather than be stored.
	let origin: string;
	try {
		origin = normalizeHost(host);
	} catch (err) {
		return {
			ok: false,
			error: {
				code: 'host_invalid',
				message: err instanceof Error ? err.message : String(err),
				remedy: 'Re-run with `facet init --host https://your-worker.workers.dev`; everything already done is detected and skipped.',
				resume: 'facet init --host <url>',
			},
		};
	}
	writeInstallState(local.layout.repoRoot, { host: origin, workerName: local.workerName });
	ui.ok(`Deployed to ${origin}`);

	// A brand-new workers.dev subdomain, and especially a fresh custom domain, needs a moment before
	// it answers. Poll rather than failing the whole install on a cold DNS/cert.
	for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++) {
		if ((await probeHealth(origin, deps.fetchImpl)) === 'ok') {
			ui.ok('Deployment is answering /api/health.');
			return { ok: true, value: origin };
		}
		if (attempt === 1) ui.info('Waiting for the deployment to come up…');
		await deps.sleep(HEALTH_INTERVAL_MS);
	}
	return {
		ok: false,
		error: {
			code: 'health_timeout',
			message: `${origin} did not answer /api/health within ${(HEALTH_ATTEMPTS * HEALTH_INTERVAL_MS) / 1000}s.`,
			remedy: hostname
				? 'A new custom domain can take a few minutes to get its DNS record and certificate. Wait, then re-run — nothing already created is created again, and the site and key steps pick up from here.'
				: 'Check `wrangler tail` for a startup error, then re-run.',
			resume: 'facet init',
		},
	};
}

async function stepAdminToken(ctx: Ctx): Promise<CfResult<string>> {
	const { ui, local, deps, opts, prompter } = ctx;
	ui.step(ctx.stepIndex, TOTAL_STEPS, 'Admin token');
	const stored = readAdminToken(local.layout, deps.env);
	const names = await secretNames(ctx.wrangler);
	const deployedHasToken =
		names.ok && names.value !== null && names.value.includes('ADMIN_TOKEN');

	if (deployedHasToken && stored && !opts.rotateAdminToken) {
		ui.skip('Worker secret ADMIN_TOKEN is set and this machine has a copy.');
		return { ok: true, value: stored };
	}
	if (opts.dryRun) {
		ui.info('would run: wrangler secret put ADMIN_TOKEN (value piped on stdin, never in argv)');
		return { ok: true, value: 'PENDING' };
	}
	if (deployedHasToken && !stored && !opts.rotateAdminToken) {
		const rotate = await prompter.confirm(
			'The Worker has an ADMIN_TOKEN but this machine has no copy. Generate a new one (the old one stops working)?',
			true,
		);
		if (!rotate) {
			return {
				ok: false,
				error: {
					code: 'admin_token_unavailable',
					message:
						'Without the admin token the installer cannot create a site or issue a key.',
					remedy: 'Export the existing token as FACET_ADMIN_TOKEN and re-run, or re-run with `facet init --rotate-admin-token` to replace it.',
					resume: 'facet init',
				},
			};
		}
	}

	const token = deps.randomToken();
	const put = await secretPut(ctx.wrangler, 'ADMIN_TOKEN', token);
	if (!put.ok) return put;
	writeDevVar(local.layout.devVarsPath, 'ADMIN_TOKEN', token);
	ui.ok(
		`Admin token stored as a Worker secret and saved to ${local.layout.devVarsPath} (mode 0600).`,
	);
	ui.info('It is never printed. `facet doctor` and the admin commands read it from that file.');
	return { ok: true, value: token };
}

interface SiteResult {
	site: Site;
	created: boolean;
}

/** Map an admin-API failure to something actionable — a 401 here almost always means a rotated token. */
function adminError(operation: string, err: unknown, host: string): CfError {
	const message = err instanceof Error ? err.message : String(err);
	if (/invalid_admin_token|401|unauthorized/i.test(message)) {
		return {
			code: 'admin_unauthorized',
			message: `${host} rejected the admin token while ${operation}.`,
			remedy: 'The deployed ADMIN_TOKEN and the local copy have diverged. Re-run with `facet init --rotate-admin-token` to set a fresh one, or export the correct value as FACET_ADMIN_TOKEN.',
			resume: 'facet init --rotate-admin-token',
		};
	}
	return {
		code: 'admin_request_failed',
		message: `${operation} failed against ${host}: ${message}`,
		remedy: 'Check that the deployment is healthy (`curl <host>/api/health`) and re-run.',
		resume: 'facet init',
	};
}

async function stepSite(
	ctx: Ctx,
	host: string,
	token: string,
	name: string,
	domain: string,
): Promise<CfResult<SiteResult>> {
	const { ui, opts, deps, local } = ctx;
	ui.step(ctx.stepIndex, TOTAL_STEPS, 'Site');
	if (opts.dryRun) {
		ui.info(`would create the site "${name}" (${domain}) via POST ${host}/api/sites`);
		return {
			ok: true,
			value: { site: { id: 'PENDING', name, domain, created_at: 0 }, created: true },
		};
	}
	const api = adminClient(host, token, deps.fetchJson);
	try {
		const { sites } = await api.get<{ sites: Site[] }>('/api/sites');
		const match =
			sites.find((s) => s.id === local.install.siteId) ??
			sites.find((s) => s.domain === domain);
		if (match) {
			ui.skip(`Reusing the existing site "${match.name}" (${match.domain}).`);
			writeInstallState(local.layout.repoRoot, {
				siteId: match.id,
				siteDomain: match.domain,
			});
			return { ok: true, value: { site: match, created: false } };
		}
		const { site } = await api.post<{ site: Site }>('/api/sites', { name, domain });
		writeInstallState(local.layout.repoRoot, { siteId: site.id, siteDomain: site.domain });
		ui.ok(`Created site "${site.name}" (${site.domain}).`);
		return { ok: true, value: { site, created: true } };
	} catch (err) {
		return { ok: false, error: adminError('creating the site', err, host) };
	}
}

/**
 * Wrapped in an object rather than returned bare so that "no new key was issued" (the site already
 * had one, or this is a dry run) stays distinguishable from a failed step.
 */
interface KeyResult {
	key: string | null;
}

async function stepKey(
	ctx: Ctx,
	host: string,
	token: string,
	siteId: string,
): Promise<CfResult<KeyResult>> {
	const { ui, opts, deps } = ctx;
	ui.step(ctx.stepIndex, TOTAL_STEPS, 'API key');
	if (opts.dryRun) {
		ui.info(`would issue an API key via POST ${host}/api/keys`);
		return { ok: true, value: { key: null } };
	}
	const api = adminClient(host, token, deps.fetchJson);
	try {
		const { keys } = await api.get<{ keys: ApiKeyRecord[] }>(`/api/keys?site_id=${siteId}`);
		if (keys.length > 0 && !opts.newKey) {
			ui.skip(`${keys.length} key(s) already issued for this site.`);
			ui.info(
				'Key plaintext is unrecoverable by design — run `facet init --new-key` to issue another.',
			);
			return { ok: true, value: { key: null } };
		}
		const issued = await api.post<{ id: string; key: string }>('/api/keys', {
			site_id: siteId,
			label: 'dashboard',
		});
		ui.ok(`Issued key ${issued.id}.`);
		return { ok: true, value: { key: issued.key } };
	} catch (err) {
		return { ok: false, error: adminError('issuing the API key', err, host) };
	}
}

// ── orchestration ──────────────────────────────────────────────────────────

function printSummary(
	ui: Ui,
	host: string,
	site: Site,
	key: string | null,
	devVarsPath: string,
): void {
	ui.blank();
	ui.heading('Facet is live');
	ui.out(`  Dashboard   ${pc.cyan(host)}\n`);
	ui.out(`  Site        ${site.name} (${site.domain})\n`);
	ui.out(`  Site ID     ${site.id}\n`);
	ui.blank();
	if (key) {
		// Printed once, deliberately: only the hash is stored server-side, so this is the sole moment
		// the plaintext exists anywhere. It is not written to any file.
		ui.out(`  ${pc.yellow('API key — shown once, cannot be retrieved again:')}\n`);
		ui.out(`  ${pc.bold(key)}\n`);
		ui.blank();
		ui.out(
			`  Open ${host}, choose ${pc.bold('Add site')}, and paste the Site ID and API key.\n`,
		);
		ui.out(
			`  ${pc.dim('They are stored in your browser only; the key is never sent by email or in a URL.')}\n`,
		);
	} else {
		ui.out(`  Open ${host} and connect with an existing API key,\n`);
		ui.out(`  or run ${pc.bold('facet init --new-key')} to issue a fresh one.\n`);
	}
	ui.blank();
	ui.out(`  Add this to the <head> of ${site.domain}:\n`);
	ui.out(
		`  ${pc.dim(`<script defer src="${host}/facet.js" data-site-id="${site.id}"></script>`)}\n`,
	);
	ui.blank();
	ui.out(`  Admin token: ${devVarsPath} ${pc.dim('(mode 0600, never printed)')}\n`);
	ui.out(`  Diagnose anytime with ${pc.bold('facet doctor')}.\n`);
}

export async function runInit(args: string[], overrides: Partial<InitDeps> = {}): Promise<number> {
	const deps: InitDeps = { ...defaultDeps(), ...overrides };
	const ui = createUi(deps.out, deps.err);
	const opts = parse(args);
	// Non-interactive (--yes, a pipe, CI) must never hang on a prompt: take every default out loud.
	const prompter =
		deps.prompter ??
		(opts.yes || opts.dryRun || !deps.isTty ? autoPrompter(deps.out) : ttyPrompter());

	const layout = findLayout(deps.cwd, opts.config);
	if (!layout.ok) return bail(ui, layout.error);
	const local = readLocalState(layout.value);

	ui.heading(opts.dryRun ? 'Facet install — dry run (nothing will change)' : 'Facet install');
	ui.info(`Checkout   ${local.layout.repoRoot}`);
	ui.info(`Worker     ${local.workerName}`);
	ui.info(
		`Database   ${opts.db ?? local.dbName}${local.dbId ? ' (id configured)' : ' (id not set yet)'}`,
	);
	ui.info(`Route      ${local.routePattern ?? '*.workers.dev'}`);
	if (local.install.host) ui.info(`Last known deployment ${local.install.host}`);

	const found = await findWrangler(deps.run, local.layout.repoRoot, local.layout.serverDir);
	if (!found.ok) return bail(ui, found.error);
	const wrangler = found.value;
	ui.info(`wrangler   ${wrangler.version}`);

	const accounts = await whoami(wrangler);
	if (!accounts.ok) return bail(ui, accounts.error);
	const account = selectAccount(accounts.value, deps.env.CLOUDFLARE_ACCOUNT_ID);
	if (!account.ok) return bail(ui, account.error);
	ui.info(`Account    ${account.value.name}`);

	// Everything interactive happens here, before any long-running work, so the rest runs unattended.
	let hostname: string | null;
	if (opts.workersDev) hostname = null;
	else if (opts.hostname) hostname = opts.hostname;
	else if (local.routePattern && !local.routeIsUpstream) hostname = local.routePattern;
	else {
		if (local.routeIsUpstream) {
			ui.blank();
			ui.warn(
				`wrangler.jsonc routes to ${local.routePattern} — the upstream project's own domain. Unless that zone is on your Cloudflare account, the deploy will be rejected.`,
			);
		}
		const answer = await prompter.text(
			'Hostname to serve Facet on (blank = free *.workers.dev URL)',
			'',
		);
		hostname = answer === '' ? null : answer.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	}

	const siteDomain =
		opts.siteDomain ??
		(await prompter.text(
			'Domain of the site you want to track',
			local.install.siteDomain ?? hostname ?? 'example.com',
		));
	const siteName =
		opts.siteName ??
		(await prompter.text('Name for that site', siteNameFromDomain(siteDomain)));

	ui.blank();
	ui.info(
		`Plan: deploy Worker "${local.workerName}" to Cloudflare account "${account.value.name}",`,
	);
	ui.info(
		`      create/reuse D1 database "${opts.db ?? local.dbName}"${local.queuesEnabled ? ` and queue "${local.queueName}"` : ''},`,
	);
	ui.info(
		`      serve on ${hostname ?? '*.workers.dev'}, then create site "${siteName}" (${siteDomain}).`,
	);
	if (local.queuesEnabled) {
		ui.info(
			'      Cloudflare Queues needs the Workers Paid plan; the installer offers to disable it if unavailable.',
		);
	}

	if (!opts.dryRun) {
		const go = await prompter.confirm('Proceed?', true);
		if (!go) {
			ui.info('Nothing changed.');
			prompter.close();
			return 0;
		}
	}

	const ctx: Ctx = { ui, deps, opts, prompter, local, wrangler, stepIndex: 1 };
	const run = async <T>(fn: () => Promise<CfResult<T>>): Promise<T | null> => {
		const result = await fn();
		ctx.stepIndex += 1;
		if (result.ok) return result.value;
		bail(ui, result.error);
		return null;
	};

	try {
		if ((await run(() => stepDependencies(ctx))) === null) return 1;
		const dbId = await run(() => stepDatabase(ctx));
		if (dbId === null) return 1;
		if ((await run(() => stepQueue(ctx))) === null) return 1;
		if ((await run(() => stepHostname(ctx, hostname))) === null) return 1;
		if ((await run(() => stepMigrations(ctx, opts.db ?? local.dbName))) === null) return 1;
		if ((await run(() => stepBuild(ctx))) === null) return 1;
		const host = await run(() => stepDeploy(ctx, hostname));
		if (host === null) return 1;
		const token = await run(() => stepAdminToken(ctx));
		if (token === null) return 1;
		const site = await run(() => stepSite(ctx, host, token, siteName, siteDomain));
		if (site === null) return 1;
		const key = await run(() => stepKey(ctx, host, token, site.site.id));
		if (key === null) return 1;

		if (opts.dryRun) {
			ui.blank();
			ui.heading('Dry run complete — nothing was created, written, or deployed.');
			ui.info('Run `facet init` to execute the plan above.');
			return 0;
		}
		printSummary(ui, host, site.site, key.key, local.layout.devVarsPath);
		return 0;
	} finally {
		prompter.close();
	}
}
