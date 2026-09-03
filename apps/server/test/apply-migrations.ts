import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

// pool-workers 0.18 isolates storage per test file, not per test (the old `isolatedStorage`).
// Restore per-test isolation: wipe all binding storage and re-apply migrations before each test,
// so every test starts from a migrated-but-empty database exactly as before.
//
// CRM_DB is a separate D1 database with its own migration set, so it is reset and migrated
// independently for the engine-level CRM integrity suite.
beforeEach(async () => {
	await reset();
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await applyD1Migrations(env.CRM_DB, env.TEST_CRM_MIGRATIONS);
});
