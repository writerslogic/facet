// `facet doctor` — diagnose an existing install: what is configured, what is missing, what to run.
//
// This is the output people paste into a bug report, so it states facts and never secrets: it reports
// that ADMIN_TOKEN exists, never its value, and truncates account/database identifiers.
//
// The rows are an inventory. The Next steps section is a diagnosis: every failing area is resolved
// through an ordered ladder of candidate causes, most-fundamental first, and only the FIRST match is
// reported. An install that `facet init` has never touched fails its health probe, has no sites and
// has no worker secret; naming all three hides the one fact that explains them.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Site } from '@facet/shared';
import pc from 'picocolors';
import { type FetchJson, adminClient, normalizeHost } from '../admin.js';
import {
	type CfError,
	findWrangler,
	queueExists,
	secretNames,
	selectAccount,
	whoami,
} from '../lib/cf.js';
import { type Runner, spawnRunner } from '../lib/exec.js';
import { type Health, adminToken, findLayout, probeHealth, readLocalState } from '../lib/state.js';
import { getCronTriggers } from '../lib/wranglerConfig.js';
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

/** UUID and bare-hex runs — the shapes a D1 database id, an account id or a token takes. */
const OPAQUE_ID_RE =
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b/gi;

/**
 * Flatten, redact and bound server- or tool-supplied text before it reaches a row.
 *
 * IMPORTANT: a job's `last_error` is an arbitrary exception string. It can carry a database id, an
 * account id or a token, and this report is meant to be pasted into public issues — so bounding the
 * length is not enough on its own, a 36-char UUID fits under every limit here. Identifier-shaped
 * runs are replaced outright; `truncateId` covers the ids doctor prints deliberately.
 */
function safeText(value: string, limit = 120): string {
	const flat = value.replace(/\s+/g, ' ').replace(OPAQUE_ID_RE, '<redacted>').trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** The bare command an action names, ignoring its trailing `# …` note, so two notes cannot split one remedy. */
function commandOf(action: string): string {
	const hash = action.indexOf('#');
	return (hash === -1 ? action : action.slice(0, hash)).trim();
}

// ── Cause ladders ────────────────────────────────────────────────────────────
// Pure over plain fact objects so the ORDER is testable without any of the I/O that produces them.

/** The one named cause a failing area resolved to, and the single command that clears it. */
export interface Cause {
	readonly cause: string;
	readonly action: string | null;
}

/** One rung of a ladder: whether it applies, the cause it names, the command that clears it. */
type Rung = readonly [applies: boolean, cause: string, action: string | null];

function firstRung(rungs: readonly Rung[]): Cause | null {
	for (const [applies, cause, action] of rungs) {
		if (applies) return { cause, action };
	}
	return null;
}

function fromCfError(error: CfError | null): Rung {
	return [error !== null, error === null ? '' : safeText(error.message), error?.remedy ?? null];
}

export interface LocalFacts {
	depsInstalled: boolean;
	dashboardBuilt: boolean;
	/** Whether a deployment has been recorded — an unbuilt dashboard is then a stale live UI, not a gap. */
	deployed: boolean;
}

export function diagnoseLocal(facts: LocalFacts): Cause | null {
	return firstRung([
		[
			!facts.depsInstalled,
			'node_modules is missing, so nothing in this checkout can build, deploy or run',
			'pnpm install',
		],
		[
			!facts.dashboardBuilt && facts.deployed,
			'the dashboard has never been built here, so the live install is still serving whatever was bundled last',
			'facet init',
		],
		[
			!facts.dashboardBuilt,
			'the dashboard has not been built, so the Worker has no static assets to serve',
			'pnpm --filter @facet/server bundle:assets',
		],
	]);
}

export interface ToolingFacts {
	depsInstalled: boolean;
	wrangler: CfError | null;
	login: CfError | null;
	account: CfError | null;
}

export function diagnoseTooling(facts: ToolingFacts): Cause | null {
	return firstRung([
		[
			!facts.depsInstalled,
			'node_modules is missing, so the pinned wrangler is not installed',
			'pnpm install',
		],
		fromCfError(facts.wrangler),
		fromCfError(facts.login),
		fromCfError(facts.account),
	]);
}

export interface ResourceFacts {
	/** True when wrangler or the Cloudflare login failed: nothing below could be observed. */
	toolingBlocked: boolean;
	queueRequired: boolean;
	queueExists: boolean;
	secretsListed: boolean;
	adminSecretSet: boolean;
	queueName: string;
}

export function diagnoseResources(facts: ResourceFacts): Cause | null {
	if (facts.toolingBlocked) return null;
	return firstRung([
		[
			facts.queueRequired && !facts.queueExists,
			`the queue ${facts.queueName} is bound but does not exist, so the deploy is rejected before anything else runs`,
			'facet init',
		],
		[
			!facts.secretsListed,
			'the Worker secrets could not be listed, which is what an undeployed Worker looks like',
			'facet init',
		],
		[
			!facts.adminSecretSet,
			'ADMIN_TOKEN is not set on the Worker, so every admin request is refused',
			'facet init',
		],
	]);
}

export interface DeploymentFacts {
	hostError: string | null;
	dbConfigured: boolean;
	host: string | null;
	health: Health | null;
	tokenAvailable: boolean;
	adminError: string | null;
	siteCount: number | null;
}

export function diagnoseDeployment(facts: DeploymentFacts): Cause | null {
	return firstRung([
		[
			facts.hostError !== null,
			facts.hostError === null ? '' : safeText(facts.hostError, 200),
			'facet doctor --host <url>',
		],
		[
			!facts.dbConfigured,
			'the D1 database id in wrangler.jsonc is still the placeholder, so `facet init` has never completed',
			'facet init',
		],
		[
			facts.host === null,
			'no deployment host has been recorded, so nothing has been deployed from this checkout',
			'facet init',
		],
		[
			facts.health === 'unreachable',
			'the recorded host does not answer, so the Worker is not serving at that origin',
			'facet init',
		],
		[
			facts.health === 'error',
			'/api/health answered with an error, so the Worker is reachable but unhealthy',
			'facet init',
		],
		[
			!facts.tokenAvailable,
			'no admin token is available locally, so the admin API could not be checked',
			'facet init --rotate-admin-token',
		],
		[
			facts.adminError !== null,
			`the deployment rejected the local admin token (${safeText(facts.adminError ?? '')})`,
			'facet init --rotate-admin-token',
		],
		[
			facts.siteCount === 0,
			'the deployment has no sites, so nothing can send it events',
			'facet init',
		],
	]);
}

export interface JobFacts {
	name: string;
	databaseReachable: boolean;
	migrationsApplied: boolean;
	/** Whether wrangler.jsonc declares triggers.crons at all. */
	cronConfigured: boolean;
	/** Non-null when the scheduler refused the job's cadence expression and disabled it. */
	cadenceError: string | null;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	lastError: string | null;
}

/**
 * Why a scheduled job is not producing results. The first four rungs are properties of the
 * deployment, not of the job, and are worded without the job name so N jobs collapse to one cause.
 */
export function diagnoseJob(facts: JobFacts): Cause | null {
	const neverRan = facts.lastSuccessAt === null && facts.lastFailureAt === null;
	const failedLast =
		facts.lastFailureAt !== null &&
		(facts.lastSuccessAt === null || facts.lastFailureAt > facts.lastSuccessAt);
	return firstRung([
		[
			!facts.databaseReachable,
			'the Worker cannot reach its D1 binding, so no scheduled job can read or record anything',
			'facet init',
		],
		[
			!facts.migrationsApplied,
			'the D1 migrations are not applied, so the tables the scheduled jobs write to are missing',
			'facet migrate',
		],
		[
			!facts.cronConfigured,
			'wrangler.jsonc declares no triggers.crons, so the scheduler is never invoked',
			'facet init',
		],
		[
			facts.cadenceError !== null,
			`${facts.name} is disabled by a cadence the scheduler could not parse (${safeText(facts.cadenceError ?? '')})`,
			null,
		],
		[neverRan, `${facts.name} has never run`, null],
		[
			failedLast,
			`${facts.name} last failed: ${safeText(facts.lastError ?? 'no error was recorded')}`,
			null,
		],
	]);
}

// ── Probes ───────────────────────────────────────────────────────────────────

interface JobRow {
	name: string;
	last_success_at: number | null;
	last_failure_at: number | null;
	last_error: string | null;
	// Optional because the CLI is version-skewed against the deployment it probes: a Worker predating
	// per-job cadence answers without these, and the cadence rung must stay dormant rather than
	// reporting a missing field as a disabled job.
	cadence_error?: string | null;
	last_occurrence?: number | null;
}

interface ReadyReport {
	checks: Record<string, boolean>;
	jobs: JobRow[];
}

/**
 * Read `/api/ready`. Deliberately not `adminClient`: readiness answers 503 with the body that
 * explains the failure, and the shared fetcher discards a non-2xx body. Any other status is treated
 * as unknown rather than as a diagnosis, because an auth or routing failure says nothing about jobs.
 */
async function probeReady(
	host: string,
	token: string,
	fetchImpl: typeof fetch,
): Promise<ReadyReport | null> {
	try {
		const res = await fetchImpl(`${host}/api/ready`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (res.status !== 200 && res.status !== 503) return null;
		const body = (await res.json()) as {
			checks?: Record<string, boolean>;
			scheduled_jobs?: JobRow[];
		};
		if (typeof body !== 'object' || body === null) return null;
		return {
			checks: body.checks ?? {},
			jobs: Array.isArray(body.scheduled_jobs) ? body.scheduled_jobs : [],
		};
	} catch {
		return null;
	}
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
	const row = (status: Status, label: string, detail: string) => {
		lines.push(`  ${MARK[status]} ${label.padEnd(16)} ${detail}`);
	};
	// Resolved causes, held per area and assembled in a fixed priority at the end. Emission order is
	// probe order, which is not diagnostic order, and the deduper keeps whichever entry comes first.
	let localCause: Cause | null = null;
	let routeCause: Cause | null = null;
	let toolingCause: Cause | null = null;
	let resourceCause: Cause | null = null;
	let deploymentCause: Cause | null = null;
	const jobCauses: Cause[] = [];

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
	row(
		local.dashboardBuilt ? 'ok' : 'warn',
		'dashboard build',
		local.dashboardBuilt
			? join('apps', 'dashboard', 'dist')
			: 'not built (the Worker serves it as static assets)',
	);
	// One ladder for both rows: missing dependencies are why the dashboard is not built, and a live
	// install with no local build needs a redeploy rather than a bare bundle.
	localCause = diagnoseLocal({
		depsInstalled: local.depsInstalled,
		dashboardBuilt: local.dashboardBuilt,
		deployed: Boolean(local.install.host),
	});

	row('info', 'worker', local.workerName);
	row(
		local.dbId ? 'ok' : 'missing',
		'database id',
		local.dbId
			? `${local.dbName} (${truncateId(local.dbId)})`
			: `${local.dbName} — still the placeholder`,
	);
	row(
		local.routeIsUpstream ? 'warn' : 'info',
		'route',
		local.routePattern
			? `${local.routePattern}${local.routeIsUpstream ? " — the upstream project's domain; unless that zone is on your account the deploy is rejected" : ''}`
			: '*.workers.dev (no custom domain)',
	);
	if (local.routeIsUpstream) {
		routeCause = {
			cause: "the route is the upstream project's domain; unless that zone is on your account the deploy is rejected",
			action: 'facet init --workers-dev   # or --hostname <your.domain>',
		};
	}
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
	const queueName = local.queueName ?? 'facet-ingest';
	let wranglerError: CfError | null = null;
	let loginError: CfError | null = null;
	let accountError: CfError | null = null;
	let queuePresent = true;
	let secretsListed = true;
	let adminSecretSet = true;

	const found = await findWrangler(deps.run, local.layout.repoRoot, local.layout.serverDir);
	if (!found.ok) {
		wranglerError = found.error;
		row('missing', 'wrangler', found.error.message);
	} else {
		row('ok', 'wrangler', found.value.version);
		const accounts = await whoami(found.value);
		if (!accounts.ok) {
			loginError = accounts.error;
			row('missing', 'cloudflare', accounts.error.message);
		} else {
			const account = selectAccount(accounts.value, deps.env.CLOUDFLARE_ACCOUNT_ID);
			if (!account.ok) {
				accountError = account.error;
				row('warn', 'cloudflare', account.error.message);
			} else {
				row('ok', 'cloudflare', `${account.value.name} (${truncateId(account.value.id)})`);
			}
			if (local.queuesEnabled) {
				queuePresent = await queueExists(found.value, queueName);
				row(
					queuePresent ? 'ok' : 'missing',
					'queue',
					queuePresent
						? `${queueName} exists`
						: `${queueName} does not exist — the deploy will fail`,
				);
			}
			const secrets = await secretNames(found.value);
			if (secrets.ok && secrets.value !== null) {
				adminSecretSet = secrets.value.includes('ADMIN_TOKEN');
				row(
					adminSecretSet ? 'ok' : 'missing',
					'worker secret',
					adminSecretSet ? 'ADMIN_TOKEN is set' : 'ADMIN_TOKEN is not set',
				);
				const signing = secrets.value.includes('FACET_SIGNING_JWK');
				row(
					'info',
					'signing key',
					signing ? 'FACET_SIGNING_JWK is set' : 'not configured (optional)',
				);
			} else {
				secretsListed = false;
				row(
					'warn',
					'worker secret',
					'could not be listed — the Worker may not be deployed yet',
				);
			}
		}
	}
	toolingCause = diagnoseTooling({
		depsInstalled: local.depsInstalled,
		wrangler: wranglerError,
		login: loginError,
		account: accountError,
	});
	resourceCause = diagnoseResources({
		toolingBlocked: toolingCause !== null,
		queueRequired: local.queuesEnabled,
		queueExists: queuePresent,
		secretsListed,
		adminSecretSet,
		queueName,
	});

	// ── The deployment itself.
	// A bad host is reported as a row rather than thrown: doctor is what people run when something is
	// already wrong, so it has to finish the report. It must still refuse to probe an unvalidated
	// origin, because the admin token goes to whatever this resolves to.
	const rawHost = values.host ?? local.install.host ?? null;
	let host: string | null = null;
	let hostError: string | null = null;
	if (rawHost !== null) {
		try {
			host = normalizeHost(rawHost);
		} catch (err) {
			hostError = err instanceof Error ? err.message : String(err);
		}
	}

	const token = host !== null ? adminToken(local.layout, deps.env) : null;
	let health: Health | null = null;
	let adminError: string | null = null;
	let siteCount: number | null = null;
	let ready: ReadyReport | null = null;

	if (hostError !== null) {
		row('missing', 'deployment', hostError);
	} else if (host === null) {
		row('warn', 'deployment', 'no deployment recorded — run `facet init`, or pass --host');
	} else {
		health = await probeHealth(host, deps.fetchImpl);
		row(health === 'ok' ? 'ok' : 'missing', 'deployment', `${host} — /api/health ${health}`);
		if (health === 'ok' && token) {
			try {
				const { sites } = await adminClient(host, token, deps.fetchJson).get<{
					sites: Site[];
				}>('/api/sites');
				siteCount = sites.length;
				row('ok', 'admin api', `token accepted — ${sites.length} site(s)`);
				for (const site of sites) {
					row('info', 'site', `${site.name} (${site.domain}) ${truncateId(site.id)}`);
				}
			} catch (err) {
				adminError = err instanceof Error ? err.message : String(err);
				row('missing', 'admin api', `token rejected (${safeText(adminError)})`);
			}
			if (adminError === null) ready = await probeReady(host, token, deps.fetchImpl);
		}
	}
	deploymentCause = diagnoseDeployment({
		hostError,
		dbConfigured: local.dbId !== null,
		host,
		health,
		tokenAvailable: host === null || token !== null,
		adminError,
		siteCount,
	});

	// ── Scheduled jobs. Only observable once the admin API answered.
	const crons = getCronTriggers(local.source);
	row(
		crons.length > 0 ? 'info' : 'warn',
		'cron',
		crons.length > 0
			? `${crons.join(', ')} (from the local wrangler.jsonc, not the deployed Worker)`
			: 'no triggers.crons in wrangler.jsonc — rollups and retention never run',
	);
	if (ready === null && siteCount !== null) {
		row('info', 'scheduled jobs', 'could not read /api/ready — job state is unknown');
	} else if (ready !== null) {
		const jobFacts = {
			databaseReachable: ready.checks.database !== false,
			migrationsApplied: ready.checks.migrations !== false,
			cronConfigured: crons.length > 0,
		};
		// The first three rungs are properties of the deployment, not of any one job, so resolve them
		// once against an otherwise-healthy job. Repeating "migrations are not applied" per job is the
		// pile of simultaneous complaints this whole structure exists to avoid.
		const shared = diagnoseJob({
			name: 'scheduled jobs',
			...jobFacts,
			cadenceError: null,
			lastSuccessAt: 1,
			lastFailureAt: null,
			lastError: null,
		});
		const observed: JobRow[] =
			ready.jobs.length > 0
				? ready.jobs
				: [
						{
							name: 'scheduled jobs',
							last_success_at: null,
							last_failure_at: null,
							last_error: null,
						},
					];
		if (shared !== null) {
			row('missing', 'scheduled jobs', shared.cause);
			// The inventory still lists what exists; only the cause is stated once.
			for (const job of observed) row('info', 'job', job.name);
			jobCauses.push(shared);
		} else {
			for (const job of observed) {
				const cause = diagnoseJob({
					name: job.name,
					...jobFacts,
					cadenceError: job.cadence_error ?? null,
					lastSuccessAt: job.last_success_at,
					lastFailureAt: job.last_failure_at,
					lastError: job.last_error,
				});
				row(
					cause === null ? 'ok' : 'warn',
					'job',
					cause === null ? `${job.name} — last run succeeded` : cause.cause,
				);
				if (cause !== null) jobCauses.push(cause);
			}
		}
	}

	deps.out(`${lines.join('\n')}\n`);
	deps.out(`\n${pc.bold('Next steps')}\n`);
	// Most-fundamental area first, then collapse to one entry per remedy: two causes cleared by the
	// same command are one piece of work, and the more fundamental one is the one worth naming.
	const ordered = [
		localCause,
		deploymentCause,
		toolingCause,
		resourceCause,
		routeCause,
		...jobCauses,
	];
	const seen = new Set<string>();
	const resolved: Cause[] = [];
	for (const item of ordered) {
		if (item === null) continue;
		const key = item.action === null ? `cause:${item.cause}` : commandOf(item.action);
		if (seen.has(key)) continue;
		seen.add(key);
		resolved.push(item);
	}
	if (resolved.length === 0) {
		deps.out(`  ${pc.green('Nothing to do — this install looks complete.')}\n`);
	} else {
		for (const item of resolved) {
			if (item.action === null) {
				deps.out(`  ${pc.cyan('›')} ${item.cause}\n`);
			} else {
				deps.out(`  ${pc.cyan('›')} ${item.action}\n`);
				deps.out(`    ${pc.dim(item.cause)}\n`);
			}
		}
	}
	deps.out(`\n${pc.dim('No secret values are included in this report.')}\n`);
	return 0;
}
