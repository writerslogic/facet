// Daily-rotating salt management: fetch (or lazily create) today's salt from the `salts`
// table so visitor hashes are un-linkable across days. Real logic lands in T007.

import type { Env } from '../env.js';

/** Return the salt string for the given UTC day key (YYYY-MM-DD), creating it if absent. */
export async function getDailySalt(_env: Env, _dayKey: string): Promise<string> {
	return '';
}
