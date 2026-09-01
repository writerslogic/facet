// Typed wrappers over the wrangler subcommands the installer needs, plus the failure classifier.
//
// WHY a classifier: wrangler reports everything as a non-zero exit with prose on stderr. "Error:
// undefined" helps nobody, so every call site turns a failure into {what happened, what to do, how to
// resume}. Unmatched failures still carry wrangler's own message rather than being swallowed.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_SPAWN_FAILED, type RunResult, type Runner } from './exec.js';

/** A user-facing failure: what went wrong, what to do about it, and how to pick up again. */
export interface CfError {
	code: string;
	message: string;
	remedy: string;
	/** Command that resumes the install once the remedy is applied. */
	resume?: string;
}

export type CfResult<T> = { ok: true; value: T } | { ok: false; error: CfError };

export const RESUME = 'facet init';

export interface Wrangler {
	/** Absolute path or bare name of the wrangler binary. */
	bin: string;
	/** Major version parsed from `wrangler --version`. */
	major: number;
	version: string;
	/** Directory wrangler runs in (apps/server), so it picks up wrangler.jsonc automatically. */
	cwd: string;
	run: Runner;
}

export interface Account {
	id: string;
	name: string;
}

const MIN_WRANGLER_MAJOR = 4;

function fail(
	code: string,
	message: string,
	remedy: string,
	resume = RESUME,
): { ok: false; error: CfError } {
	return { ok: false, error: { code, message, remedy, resume } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Everything wrangler printed, trimmed — used as the fallback detail for unclassified failures. */
function detail(result: RunResult): string {
	const text = `${result.stderr}\n${result.stdout}`.trim();
	return text === '' ? `exit code ${result.code}` : text;
}

/**
 * Locate wrangler: the repo-local binary first (the version this repo is pinned to and tested
 * against), then whatever is on PATH.
 */
export async function findWrangler(
	run: Runner,
	repoRoot: string,
	serverDir: string,
): Promise<CfResult<Wrangler>> {
	const local = join(repoRoot, 'node_modules', '.bin', 'wrangler');
	const candidates = existsSync(local) ? [local, 'wrangler'] : ['wrangler'];
	let last: RunResult | null = null;
	for (const bin of candidates) {
		const result = await run(bin, ['--version'], { cwd: serverDir });
		last = result;
		if (result.code !== 0) continue;
		const version = `${result.stdout} ${result.stderr}`.match(/\d+\.\d+\.\d+/)?.[0] ?? '0.0.0';
		const major = Number(version.split('.')[0] ?? 0);
		if (major < MIN_WRANGLER_MAJOR) {
			return fail(
				'wrangler_too_old',
				`wrangler ${version} is too old — Facet needs v${MIN_WRANGLER_MAJOR} or newer.`,
				'Run `pnpm install` in the repo root (wrangler is pinned as a devDependency), or upgrade a global install with `npm i -g wrangler@4`.',
			);
		}
		return { ok: true, value: { bin, major, version, cwd: serverDir, run } };
	}
	return fail(
		'wrangler_missing',
		last?.code === EXIT_SPAWN_FAILED
			? 'wrangler was not found on this machine.'
			: `wrangler could not be run: ${last ? detail(last) : 'unknown error'}`,
		'Run `pnpm install` in the repo root — wrangler is pinned as a devDependency — or install it globally with `npm i -g wrangler@4`.',
	);
}

function exec(w: Wrangler, args: string[], stream = false, stdin?: string): Promise<RunResult> {
	return w.run(w.bin, args, { cwd: w.cwd, stream, stdin });
}

/** Who wrangler is logged in as. Non-zero exit means "not authenticated" for `whoami --json`. */
export async function whoami(w: Wrangler): Promise<CfResult<Account[]>> {
	const result = await exec(w, ['whoami', '--json']);
	if (result.code !== 0) {
		if (/CLOUDFLARE_API_TOKEN|not authenticated|not logged in|OAuth/i.test(detail(result))) {
			return fail(
				'not_authenticated',
				'wrangler is not logged in to Cloudflare.',
				'Run `wrangler login` and complete the browser flow. On a headless machine, create an API token with Workers/D1 edit permissions and export CLOUDFLARE_API_TOKEN instead.',
			);
		}
		return fail(
			'whoami_failed',
			`Could not read your Cloudflare login: ${detail(result)}`,
			'Run `wrangler whoami` to see the raw error, then `wrangler login` if you are signed out.',
		);
	}
	// IMPORTANT: a shape wrangler never promised must classify, not throw — every caller of this
	// module expects a CfError, not a stack trace out of the installer.
	const unparsable = fail(
		'whoami_unparsable',
		'wrangler whoami returned output this installer could not parse.',
		'Run `wrangler whoami --json` and check the output; a wrangler upgrade usually fixes it.',
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return unparsable;
	}
	if (!isRecord(parsed)) return unparsable;
	const accounts = parsed.accounts ?? [];
	if (!Array.isArray(accounts)) return unparsable;
	const value: Account[] = [];
	for (const entry of accounts) {
		if (!isRecord(entry)) continue;
		const id = entry.id;
		if (typeof id !== 'string' || id === '') continue;
		value.push({
			id,
			name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
		});
	}
	if (value.length === 0) {
		return fail(
			'no_account',
			'Your Cloudflare login has no account attached.',
			'Open the Cloudflare dashboard and create (or get invited to) an account, then re-run.',
		);
	}
	return { ok: true, value };
}

/**
 * Pick the account to deploy into. One account → that one, no question asked. Several → wrangler
 * itself refuses to guess, so we require CLOUDFLARE_ACCOUNT_ID and name the choices.
 */
export function selectAccount(accounts: Account[], envAccountId?: string): CfResult<Account> {
	if (envAccountId) {
		const match = accounts.find((a) => a.id === envAccountId);
		return match
			? { ok: true, value: match }
			: fail(
					'account_not_found',
					`CLOUDFLARE_ACCOUNT_ID is set to ${envAccountId}, which is not one of your accounts.`,
					`Set it to one of: ${accounts.map((a) => `${a.name} (${a.id})`).join(', ')}.`,
				);
	}
	if (accounts.length === 1 && accounts[0]) return { ok: true, value: accounts[0] };
	return fail(
		'ambiguous_account',
		'Your login has access to more than one Cloudflare account, so the target is ambiguous.',
		`Export CLOUDFLARE_ACCOUNT_ID for the account you want: ${accounts
			.map((a) => `${a.name} (${a.id})`)
			.join(', ')}.`,
	);
}

export interface D1Database {
	uuid: string;
	name: string;
}

function parseD1(json: string): D1Database[] {
	try {
		const parsed = JSON.parse(json) as unknown;
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		return rows
			.map((row) => row as { uuid?: string; name?: string; database_id?: string })
			.filter((row) => Boolean(row.uuid ?? row.database_id))
			.map((row) => ({
				uuid: (row.uuid ?? row.database_id) as string,
				name: row.name ?? '',
			}));
	} catch {
		return [];
	}
}

function isUnauthorized(text: string): boolean {
	return /authentication|unauthorized|10000/i.test(text);
}

/** Look up a D1 database by name. `null` means "does not exist", which is not an error. */
export async function d1Find(w: Wrangler, name: string): Promise<CfResult<D1Database | null>> {
	const result = await exec(w, ['d1', 'list', '--json']);
	if (result.code !== 0) {
		const text = detail(result);
		if (isUnauthorized(text)) {
			return fail(
				'd1_permission',
				'Cloudflare rejected the D1 request as unauthorized.',
				'Your API token needs the "D1 Edit" permission (or re-run `wrangler login`, which grants it).',
			);
		}
		return fail(
			'd1_list_failed',
			`Could not list D1 databases: ${text}`,
			'Run `wrangler d1 list` to see the raw error.',
		);
	}
	return { ok: true, value: parseD1(result.stdout).find((db) => db.name === name) ?? null };
}

/** Fetch a database by id; used to verify that an id already in wrangler.jsonc still exists. */
export async function d1InfoById(w: Wrangler, id: string): Promise<CfResult<D1Database | null>> {
	const result = await exec(w, ['d1', 'info', id, '--json']);
	if (result.code !== 0) {
		// IMPORTANT: a refused read must not read as "the database is gone" — the caller answers that
		// by offering to create a fresh one and overwrite the id, which would orphan a live database.
		const text = detail(result);
		if (isUnauthorized(text)) {
			return fail(
				'd1_permission',
				`Cloudflare rejected the D1 lookup as unauthorized: ${text}`,
				'Your API token needs the "D1 Read" permission (or re-run `wrangler login`, which grants it). The configured database id was left alone.',
			);
		}
		return { ok: true, value: null };
	}
	return { ok: true, value: parseD1(result.stdout)[0] ?? null };
}

export async function d1Create(w: Wrangler, name: string): Promise<CfResult<D1Database>> {
	const result = await exec(w, ['d1', 'create', name], true);
	if (result.code !== 0) {
		const text = detail(result);
		if (/limit|exceeded|maximum number|entitlement|upgrade your plan/i.test(text)) {
			return fail(
				'd1_plan_limit',
				`Cloudflare refused to create the D1 database: ${text}`,
				'Your account is at its D1 database limit. Delete an unused database in the Cloudflare dashboard, or point Facet at an existing one with `facet init --db <existing-name>`. Nothing was written to wrangler.jsonc.',
			);
		}
		if (/already exists/i.test(text)) {
			const found = await d1Find(w, name);
			if (found.ok && found.value) return { ok: true, value: found.value };
		}
		if (isUnauthorized(text)) {
			return fail(
				'd1_permission',
				`Cloudflare rejected the create as unauthorized: ${text}`,
				'Your API token needs the "D1 Edit" permission, or re-run `wrangler login`.',
			);
		}
		return fail(
			'd1_create_failed',
			`Could not create the D1 database: ${text}`,
			`Fix the error above and re-run \`${RESUME}\` — it will reuse the database if it was in fact created.`,
		);
	}
	// `d1 create` prints a config snippet rather than JSON, so read the id back authoritatively.
	const found = await d1Find(w, name);
	if (found.ok && found.value) return { ok: true, value: found.value };
	const id = result.stdout.match(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
	)?.[0];
	if (id) return { ok: true, value: { uuid: id, name } };
	return fail(
		'd1_id_unknown',
		'The database was created but its id could not be read back.',
		`Run \`wrangler d1 info ${name} --json\` to get the id, then \`facet config set-db-id --id <id>\` and re-run.`,
	);
}

/** True when the queue exists. Absence is reported as `false`, not as an error. */
export async function queueExists(w: Wrangler, name: string): Promise<boolean> {
	const result = await exec(w, ['queues', 'info', name]);
	return result.code === 0;
}

export async function queueCreate(
	w: Wrangler,
	name: string,
): Promise<CfResult<'created' | 'exists'>> {
	const result = await exec(w, ['queues', 'create', name], true);
	if (result.code === 0) return { ok: true, value: 'created' };
	const text = detail(result);
	if (/already exists/i.test(text)) return { ok: true, value: 'exists' };
	if (/paid|entitlement|not enabled|subscription|billing|upgrade/i.test(text)) {
		return fail(
			'queue_plan_required',
			'Cloudflare Queues needs the Workers Paid plan, and this account does not have it.',
			'Facet works without Queues — ingest then writes to D1 synchronously. The installer can comment the `queues` block out of wrangler.jsonc for you, or subscribe to Workers Paid and re-run.',
		);
	}
	return fail(
		'queue_create_failed',
		`Could not create the ingest queue: ${text}`,
		`Fix the error above and re-run \`${RESUME}\`.`,
	);
}

export async function migrationsApply(w: Wrangler, dbName: string): Promise<CfResult<string>> {
	const result = await exec(w, ['d1', 'migrations', 'apply', dbName, '--remote'], true);
	if (result.code !== 0) {
		return fail(
			'migrations_failed',
			`Applying D1 migrations failed: ${detail(result)}`,
			`Check the SQL error above. Migrations are transactional per file, so the database is still consistent; fix the cause and re-run \`${RESUME}\` — already-applied migrations are skipped.`,
		);
	}
	return { ok: true, value: result.stdout };
}

/** Names of the Worker's secrets (never values — `secret list` does not expose them). */
export async function secretNames(w: Wrangler): Promise<CfResult<string[] | null>> {
	const result = await exec(w, ['secret', 'list', '--format', 'json']);
	// A Worker that has never been deployed has no secret list yet; that is a state, not a failure.
	if (result.code !== 0) return { ok: true, value: null };
	try {
		const parsed = JSON.parse(result.stdout) as { name?: string }[];
		return { ok: true, value: parsed.map((s) => s.name ?? '').filter(Boolean) };
	} catch {
		return { ok: true, value: null };
	}
}

/**
 * Store a Worker secret. The value goes in on stdin and NEVER in argv — argv is world-readable via
 * `ps`, and would also land in the shell history of anyone copying the command.
 */
export async function secretPut(w: Wrangler, name: string, value: string): Promise<CfResult<true>> {
	const result = await exec(w, ['secret', 'put', name], false, `${value}\n`);
	if (result.code !== 0) {
		return fail(
			'secret_put_failed',
			`Could not store the ${name} Worker secret: ${detail(result)}`,
			`Confirm the Worker is deployed (\`wrangler deployments list\`) and re-run \`${RESUME}\`.`,
		);
	}
	return { ok: true, value: true };
}

export interface DeployResult {
	/** The URL wrangler reported, if it printed one. */
	url: string | null;
	output: string;
}

export async function deploy(w: Wrangler): Promise<CfResult<DeployResult>> {
	const result = await exec(w, ['deploy', '--minify'], true);
	const text = detail(result);
	if (result.code !== 0) {
		if (/zone|not found for|does not belong|no zone|10077|7003/i.test(text)) {
			return fail(
				'zone_not_owned',
				`Cloudflare rejected the custom domain in wrangler.jsonc: ${text}`,
				'That zone is not on this Cloudflare account. Add the domain to Cloudflare first, or re-run with `facet init --workers-dev` to publish on the free *.workers.dev URL instead.',
			);
		}
		if (/queue|not enabled|entitlement|paid plan|subscription/i.test(text)) {
			return fail(
				'deploy_binding_unavailable',
				`The deploy was rejected because a binding is unavailable on this plan: ${text}`,
				'Re-run `facet init` and answer "no" when it offers to keep Cloudflare Queues — Facet falls back to synchronous ingest — or subscribe to Workers Paid.',
			);
		}
		if (isUnauthorized(text)) {
			return fail(
				'deploy_unauthorized',
				`Cloudflare rejected the deploy as unauthorized: ${text}`,
				'Re-run `wrangler login`, or give your API token the "Workers Scripts Edit" permission.',
			);
		}
		return fail(
			'deploy_failed',
			`The deploy failed: ${text}`,
			`Fix the error above and re-run \`${RESUME}\` — it resumes at the deploy step.`,
		);
	}
	const url = result.stdout.match(/https:\/\/[^\s'"]+\.workers\.dev/)?.[0] ?? null;
	return { ok: true, value: { url, output: result.stdout } };
}
