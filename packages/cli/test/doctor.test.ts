// `facet doctor`: the report people paste into a bug report. It must be accurate about what is
// configured, prescriptive about what to run, and free of secret values.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
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
	setup: { repo?: Repo; cloud?: CloudState; healthy?: boolean; token?: string } = {},
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
		fetchImpl: (async () => ({ ok: setup.healthy !== false })) as unknown as typeof fetch,
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

	it('fails clearly when run outside a checkout', async () => {
		const repo = { ...makeRepo(), root: '/' } as Repo;
		const h = await doctor({ repo });
		expect(h.code).toBe(1);
		expect(h.stderr).toContain('No apps/server/wrangler.jsonc found');
	});
});
