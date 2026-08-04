// Local, on-disk state the installer needs to resume — and the one place a secret touches the disk.
//
// Two files, two reasons:
//   .facet/install.json   non-secret resume state (deployment URL, site id). Carries its own
//                         .gitignore so it can never be committed, without editing the repo's.
//   apps/server/.dev.vars ADMIN_TOKEN, mode 0600. It is already gitignored, it is where wrangler dev
//                         reads local secrets from, and it is what lets a second `facet init` run
//                         talk to the admin API instead of stranding the operator.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface InstallState {
	/** Deployment origin, e.g. https://facet.example.workers.dev (no trailing slash). */
	host?: string;
	siteId?: string;
	siteDomain?: string;
	workerName?: string;
	databaseId?: string;
	updatedAt?: number;
}

const STATE_DIR = '.facet';
const STATE_FILE = 'install.json';

export function stateDir(repoRoot: string): string {
	return join(repoRoot, STATE_DIR);
}

export function readInstallState(repoRoot: string): InstallState {
	const path = join(stateDir(repoRoot), STATE_FILE);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as InstallState;
	} catch {
		// A corrupt state file must never block an install: fall back to full detection.
		return {};
	}
}

/** Merge `patch` into the stored state. Never called with a secret — see the module header. */
export function writeInstallState(repoRoot: string, patch: InstallState): InstallState {
	const dir = stateDir(repoRoot);
	mkdirSync(dir, { recursive: true });
	// Self-ignoring directory: keeps local state out of git without touching the repo's .gitignore.
	const ignore = join(dir, '.gitignore');
	if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
	const next = { ...readInstallState(repoRoot), ...patch, updatedAt: Date.now() };
	const path = join(dir, STATE_FILE);
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	return next;
}

/** Read one variable out of a `.dev.vars` file. Returns null when the file or key is absent. */
export function readDevVar(devVarsPath: string, key: string): string | null {
	if (!existsSync(devVarsPath)) return null;
	for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq > 0 && trimmed.slice(0, eq).trim() === key) return trimmed.slice(eq + 1).trim();
	}
	return null;
}

/**
 * Upsert one variable in `.dev.vars`, forcing mode 0600. The file is created if missing and other
 * lines are preserved byte-for-byte.
 */
export function writeDevVar(devVarsPath: string, key: string, value: string): void {
	mkdirSync(dirname(devVarsPath), { recursive: true });
	const exists = existsSync(devVarsPath);
	const existing = exists ? readFileSync(devVarsPath, 'utf8') : '';
	const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n');
	const idx = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
	if (idx >= 0) lines[idx] = `${key}=${value}`;
	else lines.push(`${key}=${value}`);
	// Tighten BEFORE the secret lands, not after. `writeFileSync` applies `mode` only when it creates
	// the file, so on a `.dev.vars` that already existed under a laxer mode — one the operator made by
	// hand, or that a umask widened — chmod-ing afterwards leaves the value readable for the window
	// between the two calls. This file holds ADMIN_TOKEN and FACET_SIGNING_JWK.
	if (exists) chmodSync(devVarsPath, 0o600);
	writeFileSync(devVarsPath, `${lines.join('\n')}\n`, { mode: 0o600 });
}
