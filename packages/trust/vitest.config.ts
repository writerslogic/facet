// Trust primitives are tested in the real workerd runtime (via @cloudflare/vitest-pool-workers), not
// Node, so every crypto path we ship is proven to run where the Worker runs. No bindings are needed
// beyond Web Crypto; nodejs_compat mirrors the server so jose resolves its workerd export condition.

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				singleWorker: true,
				miniflare: {
					compatibilityDate: '2026-07-01',
					compatibilityFlags: ['nodejs_compat'],
				},
			},
		},
	},
});
