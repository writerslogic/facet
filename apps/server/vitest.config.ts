import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
	const migrations = await readD1Migrations(
		fileURLToPath(new URL('./migrations', import.meta.url)),
	);

	return {
		test: {
			setupFiles: ['./test/apply-migrations.ts'],
			poolOptions: {
				workers: {
					singleWorker: true,
					isolatedStorage: true,
					// Uses wrangler.test.jsonc (wrangler.jsonc minus the `ai` binding, which crashes
					// this miniflare version). See that file's header for the rationale.
					wrangler: { configPath: './wrangler.test.jsonc' },
					miniflare: {
						bindings: {
							ADMIN_TOKEN: 'test-admin-token',
							RAW_RETENTION_DAYS: '90',
							TEST_MIGRATIONS: migrations,
						},
					},
				},
			},
		},
	};
});
