import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/env.js';

declare global {
	namespace Cloudflare {
		interface Env extends WorkerEnv {
			TEST_MIGRATIONS: D1Migration[];
			TEST_CRM_MIGRATIONS: D1Migration[];
			/** Bound in the test config so the CRM path is exercisable. It stays OPTIONAL in `Env`
			 * because a real deployment may never create the database — that is the whole gate. */
			CRM_DB: D1Database;
		}
	}
}
