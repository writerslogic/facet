// `facet doctor`: the report people paste into a bug report. It must be accurate about what is
// configured, prescriptive about what to run, and free of secret values.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseDeployment, diagnoseJob, runDoctor } from '../src/commands/doctor.js';
import {
	type CloudState,
	type Repo,
	cloudState,
	fakeAdmin,
	fakeRunner,
	makeRepo,
} from './support.js';

const TOKEN = 'f'.repeat(64);
const DB_ID = '11111111-2222-4333-8444-555555555555';

async function doctor(
	setup: {
		repo?: Repo;
		cloud?: CloudState;
		healthy?: boolean;
		token?: string;
		fetchImpl?: typeof fetch;
	} = {},
) {
	const repo = setup.repo ?? makeRepo();
	const cloud = setup.cloud ?? cloudState();
	const admin = fakeAdmin(setup.token ?? TOKEN, {
		sites: [
			{
				id: '77777777-6666-4555-8444-333333333333',
				name: 'Example',
				domain: 'example.com',
				created_at: 1,
			},
		],
	});
	let stdout = '';
	let stderr = '';
	const code = await runDoctor([], {
		run: fakeRunner(cloud).runner,
		fetchJson: admin.fetchJson,
		fetchImpl:
			setup.fetchImpl ??
			((async () => ({ ok: setup.healthy !== false })) as unknown as typeof fetch),
		cwd: repo.root,
		out: (chunk) => {
			stdout += chunk;
		},
		err: (chunk) => {
			stderr += chunk;
		},
		env: {},
		nodeVersion: 'v22.14.0',
	});
	return { code, stdout, stderr, repo };
}

/** A checkout where `facet init` has already run to completion. */
function completedRepo(): { repo: Repo; cloud: CloudState } {
	const repo = makeRepo();
	writeFileSync(
		repo.configPath,
		repo
			.config()
			.replace('PLACEHOLDER_D1_DATABASE_ID', DB_ID)
			.replace('"routes": [', '// "routes": ['),
	);
	writeFileSync(repo.devVars, `ADMIN_TOKEN=${TOKEN}\n`);
	mkdirSync(join(repo.root, '.facet'), { recursive: true });
	writeFileSync(
		repo.stateFile(),
		JSON.stringify({ host: 'https://facet.acme.workers.dev', siteId: 'x' }),
	);
	mkdirSync(join(repo.root, 'apps', 'dashboard', 'dist'), { recursive: true });
	writeFileSync(join(repo.root, 'apps', 'dashboard', 'dist', 'index.html'), '<!doctype html>');
	return {
		repo,
		cloud: cloudState({
			databases: [{ uuid: DB_ID, name: 'facet' }],
			queues: ['facet-ingest'],
			secrets: ['ADMIN_TOKEN'],
		}),
	};
}

describe('facet doctor', () => {
	it('names everything missing in a fresh clone and what to run', async () => {
		const h = await doctor({ healthy: false });
		expect(h.code).toBe(0);
		expect(h.stdout).toContain('still the placeholder');
		expect(h.stdout).toContain('facet.writerslogic.com');
		expect(h.stdout).toContain("upstream project's domain");
		expect(h.stdout).toContain('facet-ingest does not exist');
		expect(h.stdout).toContain('no deployment recorded');
		expect(h.stdout).toContain('Next steps');
		expect(h.stdout).toContain('facet init');
	});

	it('reports a complete install as complete', async () => {
		const { repo, cloud } = completedRepo();
		const h = await doctor({ repo, cloud });
		expect(h.stdout).toContain('ADMIN_TOKEN is set');
		expect(h.stdout).toContain('token accepted — 1 site(s)');
		expect(h.stdout).toContain('Example (example.com)');
		expect(h.stdout).toContain('Nothing to do');
	});

	it('flags a rejected admin token with the rotation command', async () => {
		const { repo, cloud } = completedRepo();
		const h = await doctor({ repo, cloud, token: 'a-different-token' });
		expect(h.stdout).toContain('token rejected');
		expect(h.stdout).toContain('facet init --rotate-admin-token');
	});

	it('never prints a secret value or a full identifier', async () => {
		const { repo, cloud } = completedRepo();
		const h = await doctor({ repo, cloud });
		expect(h.stdout).not.toContain(TOKEN);
		expect(h.stdout).not.toContain(DB_ID);
		expect(h.stdout).toContain('value never shown');
		expect(h.stdout).toContain('No secret values are included in this report.');
	});

	it('reports a missing wrangler without aborting the rest of the report', async () => {
		const h = await doctor({ cloud: cloudState({ missing: true }) });
		expect(h.code).toBe(0);
		expect(h.stdout).toContain('wrangler was not found');
		expect(h.stdout).toContain('node');
		expect(h.stdout).toContain('Next steps');
	});

	it('refuses to probe a plain-http host from install.json and still finishes the report', async () => {
		const { repo, cloud } = completedRepo();
		writeFileSync(
			repo.stateFile(),
			JSON.stringify({ host: 'http://facet.acme.workers.dev', siteId: 'x' }),
		);
		let probes = 0;
		const h = await doctor({
			repo,
			cloud,
			fetchImpl: (async () => {
				probes++;
				return { ok: true };
			}) as unknown as typeof fetch,
		});
		expect(probes).toBe(0);
		expect(h.code).toBe(0);
		expect(h.stdout).toContain('unencrypted');
		expect(h.stdout).toContain('facet doctor --host');
		// The rest of the report still rendered.
		expect(h.stdout).toContain('ADMIN_TOKEN is set');
	});

	it('fails clearly when run outside a checkout', async () => {
		const repo = { ...makeRepo(), root: '/' } as Repo;
		const h = await doctor({ repo });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('No apps/server/wrangler.jsonc found');
	});
});

// The point of the ladders: a broken install trips several rungs at once, and the report is only
// useful if it names the one that explains the others.
describe('cause ordering', () => {
	it('names the fundamental cause rather than the symptoms stacked on top of it', () => {
		const broken = {
			name: 'rollups',
			databaseReachable: false,
			migrationsApplied: false,
			cronConfigured: false,
			cadenceError: 'every 5 fortnights',
			lastSuccessAt: null,
			lastFailureAt: 1,
			lastError: 'boom',
		};
		expect(diagnoseJob(broken)?.cause).toContain('D1 binding');

		expect(diagnoseJob({ ...broken, databaseReachable: true })?.cause).toContain('migrations');
		expect(
			diagnoseJob({ ...broken, databaseReachable: true, migrationsApplied: true })?.cause,
		).toContain('triggers.crons');
		// A malformed cadence outranks "never run" and "last run failed", which it causes.
		expect(
			diagnoseJob({
				...broken,
				databaseReachable: true,
				migrationsApplied: true,
				cronConfigured: true,
			})?.cause,
		).toContain('every 5 fortnights');
		expect(
			diagnoseJob({
				...broken,
				databaseReachable: true,
				migrationsApplied: true,
				cronConfigured: true,
				cadenceError: null,
			})?.cause,
		).toContain('last failed: boom');
	});

	// doctor output is meant to be pasted into public issues, and a job's last_error is an arbitrary
	// exception string. Length bounding alone does not cover this: a UUID fits under every limit.
	it('redacts an identifier carried in a job error', () => {
		const cause = diagnoseJob({
			name: 'rollups',
			databaseReachable: true,
			migrationsApplied: true,
			cronConfigured: true,
			cadenceError: null,
			lastSuccessAt: null,
			lastFailureAt: 1,
			lastError: `D1_ERROR: no such table on database ${DB_ID}`,
		})?.cause;
		expect(cause).not.toContain(DB_ID);
		expect(cause).toContain('<redacted>');
	});

	it('names the fundamental deployment cause rather than the symptoms stacked on top of it', () => {
		// An install that was never created is unreachable and has no sites; only the first is a cause.
		expect(
			diagnoseDeployment({
				hostError: null,
				dbConfigured: false,
				host: 'https://facet.example.workers.dev',
				health: 'unreachable',
				tokenAvailable: false,
				adminError: null,
				siteCount: 0,
			})?.cause,
		).toContain('placeholder');
	});
});
