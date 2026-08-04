// Local, on-disk state the installer needs to resume — and the one place a secret touches the disk.
//
// Two files, two reasons:
//   .facet/install.json   non-secret resume state (deployment URL, site id). Carries its own
//                         .gitignore so it can never be committed, without editing the repo's.
//   apps/server/.dev.vars ADMIN_TOKEN, mode 0600. It is already gitignored, it is where wrangler dev
//                         reads local secrets from, and it is what lets a second `facet init` run
//                         talk to the admin API instead of stranding the operator.
//
// Nothing here asks whether a path exists before acting on it. Every operation opens or writes and
// handles the failure, so there is no window between the check and the use in which the path could
// be replaced or its mode widened.

import {
	closeSync,
	fchmodSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
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

function errnoCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException | undefined)?.code;
}

export function stateDir(repoRoot: string): string {
	return join(repoRoot, STATE_DIR);
}

export function readInstallState(repoRoot: string): InstallState {
	try {
		return JSON.parse(
			readFileSync(join(stateDir(repoRoot), STATE_FILE), 'utf8'),
		) as InstallState;
	} catch {
		// A missing or corrupt state file must never block an install: fall back to full detection.
		return {};
	}
}

/** Merge `patch` into the stored state. Never called with a secret — see the module header. */
export function writeInstallState(repoRoot: string, patch: InstallState): InstallState {
	const dir = stateDir(repoRoot);
	mkdirSync(dir, { recursive: true });
	// Self-ignoring directory: keeps local state out of git without touching the repo's .gitignore.
	// `wx` creates it or fails with EEXIST, so an operator's edited .gitignore is never clobbered.
	try {
		writeFileSync(join(dir, '.gitignore'), '*\n', { flag: 'wx' });
	} catch (err) {
		if (errnoCode(err) !== 'EEXIST') throw err;
	}
	const next = { ...readInstallState(repoRoot), ...patch, updatedAt: Date.now() };
	writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	return next;
}

/** Read one variable out of a `.dev.vars` file. Returns null when the file or key is absent. */
export function readDevVar(devVarsPath: string, key: string): string | null {
	let contents: string;
	try {
		contents = readFileSync(devVarsPath, 'utf8');
	} catch (err) {
		if (errnoCode(err) === 'ENOENT') return null;
		throw err;
	}
	for (const line of contents.split('\n')) {
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
	// One descriptor for the whole read-modify-write. `a+` creates the file at 0600 when it is
	// missing; `fchmodSync` tightens it through that same descriptor when it already existed under a
	// laxer mode — one the operator made by hand, or that a umask widened. Both settle the mode
	// before any byte of the secret is written, and neither re-resolves the path, so the file the
	// mode applies to is provably the file the secret lands in. This holds ADMIN_TOKEN and
	// FACET_SIGNING_JWK.
	const fd = openSync(devVarsPath, 'a+', 0o600);
	try {
		fchmodSync(fd, 0o600);
		const existing = readFileSync(fd, 'utf8');
		const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n');
		const idx = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
		if (idx >= 0) lines[idx] = `${key}=${value}`;
		else lines.push(`${key}=${value}`);
		// `a+` pins every write to end-of-file, so truncating first is what makes the rewrite land at
		// offset 0 rather than doubling the file.
		ftruncateSync(fd, 0);
		// `writeFileSync` over the descriptor rather than `writeSync`: it loops until every byte
		// lands, so a short write can never leave a truncated `.dev.vars` behind.
		writeFileSync(fd, `${lines.join('\n')}\n`);
	} finally {
		closeSync(fd);
	}
}
