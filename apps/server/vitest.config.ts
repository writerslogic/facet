// Vitest config for the Worker: runs tests inside workerd via @cloudflare/vitest-pool-workers
// so D1 bindings and the runtime match production.

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
