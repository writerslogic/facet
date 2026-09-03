import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
	const [migrations, crmMigrations] = await Promise.all([
		readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url))),
		// The CRM foundation lives in its own D1 database, so its engine-level tests need a separate
		// migration set and binding.
		readD1Migrations(fileURLToPath(new URL('./migrations-crm', import.meta.url))),
	]);

	return {
		plugins: [
			cloudflareTest({
				// Uses wrangler.test.jsonc (wrangler.jsonc minus the `ai` binding, which crashes
				// this miniflare version). See that file's header for the rationale.
				wrangler: { configPath: './wrangler.test.jsonc' },
				miniflare: {
					bindings: {
						ADMIN_TOKEN: 'test-admin-token',
						RAW_RETENTION_DAYS: '90',
						TEST_MIGRATIONS: migrations,
						TEST_CRM_MIGRATIONS: crmMigrations,
					},
				},
			}),
		],
		test: {
			setupFiles: ['./test/apply-migrations.ts'],
		},
	};
});
