// T037 guard: the documented local-dev key must hash to the value stored in scripts/seed.sql, so
// `clk_localdevkey` actually authenticates against a freshly seeded database.

import { describe, expect, it } from 'vitest';
import { hashKey } from '../src/lib/apikeys.js';

const DEV_KEY = 'clk_localdevkey';
const SEED_KEY_HASH = '2a043fa7fc8ab73575e5d9e2d33544b933c8ecb96892711db5f7005f0281f3bf';

describe('local-dev seed key', () => {
	it('hashes to the seed.sql key_hash literal', async () => {
		expect(await hashKey(DEV_KEY)).toBe(SEED_KEY_HASH);
	});
});
