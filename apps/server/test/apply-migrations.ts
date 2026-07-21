import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// pool-workers 0.18 isolates storage per test file, not per test (the old `isolatedStorage`).
// Restore per-test isolation: wipe all binding storage and re-apply migrations before each test,
// so every test starts from a migrated-but-empty database exactly as before.
beforeEach(async () => {
	await reset();
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
