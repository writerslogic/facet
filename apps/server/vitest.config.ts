import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { fileURLToPath } from 'node:url';

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
					wrangler: { configPath: './wrangler.jsonc' },
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
