import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import { __resetIngestDedupForTests } from '../src/lib/ingest.js';

// pool-workers 0.18 isolates storage per test file, not per test (the old `isolatedStorage`).
// Restore per-test isolation: wipe all binding storage and re-apply migrations before each test,
// so every test starts from a migrated-but-empty database exactly as before.
//
// CRM_DB is a SEPARATE D1 database with its own migration set, so it is migrated separately. It is
// bound in wrangler.test.jsonc (injected by scripts/gen-test-wrangler.mjs) so the suite can exercise
// the bound path; a test covering an unbound deployment deletes the binding from the env it hands to
// `app.request`, which is what a deployment that never created the database actually looks like.
beforeEach(async () => {
	await reset();
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await applyD1Migrations(env.CRM_DB, env.TEST_CRM_MIGRATIONS);
	// Same isolate-reuse problem as storage: ingest.ts's dedup guard is module-scope state, so it
	// leaks across tests in one file too.
	__resetIngestDedupForTests();
});
