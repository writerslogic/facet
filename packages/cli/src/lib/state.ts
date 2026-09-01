// Install-state detection shared by `facet init` and `facet doctor`.
//
// WHY detection rather than a progress file: the truth about an install lives in Cloudflare and in
// wrangler.jsonc, not in a marker we wrote. Re-reading it every run is what makes `init` idempotent —
// it can be interrupted at any step, and the next run sees exactly what already exists.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import type { CfResult } from './cf.js';
import { type InstallState, readDevVar, readInstallState } from './store.js';
import {
	UPSTREAM_ROUTE,
	getDatabaseId,
	getDatabaseName,
	getQueueName,
	getRoutePattern,
	getWorkerName,
	hasQueues,
} from './wranglerConfig.js';

export interface Layout {
	repoRoot: string;
	serverDir: string;
	configPath: string;
	devVarsPath: string;
}

const SERVER_CONFIG = join('apps', 'server', 'wrangler.jsonc');

/**
 * Locate the checkout. Walks up from `cwd` looking for apps/server/wrangler.jsonc, so the command
 * works from anywhere inside the repo, and accepts an explicit --config for unusual layouts.
 */
export function findLayout(cwd: string, configFlag?: string): CfResult<Layout> {
	if (configFlag) {
		const configPath = resolve(cwd, configFlag);
		if (!existsSync(configPath)) {
			return {
				ok: false,
				error: {
					code: 'config_missing',
					message: `No wrangler config at ${configPath}.`,
					remedy: 'Pass --config with the path to your apps/server/wrangler.jsonc.',
				},
			};
		}
		const serverDir = dirname(configPath);
		return {
			ok: true,
			value: {
				repoRoot: resolve(serverDir, '..', '..'),
				serverDir,
				configPath,
				devVarsPath: join(serverDir, '.dev.vars'),
			},
		};
	}
	let dir = resolve(cwd);
	const { root } = parse(dir);
	while (true) {
		const candidate = join(dir, SERVER_CONFIG);
		if (existsSync(candidate)) {
			const serverDir = dirname(candidate);
			return {
				ok: true,
				value: {
					repoRoot: dir,
					serverDir,
					configPath: candidate,
					devVarsPath: join(serverDir, '.dev.vars'),
				},
			};
		}
		if (dir === root) break;
		dir = dirname(dir);
	}
	return {
		ok: false,
		error: {
			code: 'not_a_checkout',
			message: `No ${SERVER_CONFIG} found in this directory or any parent.`,
			remedy: 'Run this from a Facet checkout: `git clone https://github.com/writerslogic/facet.git && cd facet && pnpm install`. To generate a standalone Worker config instead, run `facet scaffold`.',
		},
	};
}

export interface LocalState {
	layout: Layout;
	source: string;
	workerName: string;
	dbName: string;
	/** Configured database id, or null when still the placeholder. */
	dbId: string | null;
	queueName: string | null;
	queuesEnabled: boolean;
	routePattern: string | null;
	/** True when the route is the one the upstream repo ships, which a self-hoster cannot deploy. */
	routeIsUpstream: boolean;
	depsInstalled: boolean;
	dashboardBuilt: boolean;
	/** Whether an ADMIN_TOKEN is on disk in .dev.vars. Never the value — see `adminToken()`. */
	hasLocalAdminToken: boolean;
	install: InstallState;
}

// IMPORTANT: a blank value is not a token. `ADMIN_TOKEN=` on disk, or an exported-but-empty
// FACET_ADMIN_TOKEN, must read as absent — otherwise doctor reports a credential it cannot use.
function presentToken(value: string | null | undefined): string | null {
	return value !== undefined && value !== null && value.trim() !== '' ? value : null;
}

export function readLocalState(layout: Layout): LocalState {
	const source = readFileSync(layout.configPath, 'utf8');
	const routePattern = getRoutePattern(source);
	return {
		layout,
		source,
		workerName: getWorkerName(source) ?? 'facet',
		dbName: getDatabaseName(source) ?? 'facet',
		dbId: getDatabaseId(source),
		queueName: getQueueName(source),
		queuesEnabled: hasQueues(source),
		routePattern,
		routeIsUpstream: routePattern === UPSTREAM_ROUTE,
		depsInstalled: existsSync(join(layout.repoRoot, 'node_modules')),
		dashboardBuilt: existsSync(
			join(layout.repoRoot, 'apps', 'dashboard', 'dist', 'index.html'),
		),
		hasLocalAdminToken: presentToken(readDevVar(layout.devVarsPath, 'ADMIN_TOKEN')) !== null,
		install: readInstallState(layout.repoRoot),
	};
}

/** Read the stored admin token. Isolated so it is obvious at every call site that this is a secret. */
export function adminToken(layout: Layout, env: NodeJS.ProcessEnv = process.env): string | null {
	return (
		presentToken(env.FACET_ADMIN_TOKEN) ??
		presentToken(readDevVar(layout.devVarsPath, 'ADMIN_TOKEN'))
	);
}

export type Health = 'ok' | 'unreachable' | 'error';

// REQUIRED: bound every probe. Unbounded, a host that accepts the connection and never answers holds
// `init`'s retry loop open for undici's 300s header timeout per attempt.
const HEALTH_TIMEOUT_MS = 10_000;

/** Probe `<host>/api/health`. Used to confirm a deploy is live and to resume without re-deploying. */
export async function probeHealth(host: string, fetchImpl: typeof fetch = fetch): Promise<Health> {
	try {
		const res = await fetchImpl(`${host}/api/health`, {
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		});
		return res.ok ? 'ok' : 'error';
	} catch {
		return 'unreachable';
	}
}
