import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/env.js';

declare global {
	namespace Cloudflare {
		interface Env extends WorkerEnv {
			TEST_MIGRATIONS: D1Migration[];
			TEST_CRM_MIGRATIONS: D1Migration[];
			/** Bound in tests for the engine-level CRM integrity suite; optional in deployments. */
			CRM_DB: D1Database;
		}
	}
}
