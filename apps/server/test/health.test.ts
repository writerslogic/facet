// Smoke test: the Hono app boots and /api/health responds 200. Replaced/expanded per feature.

import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('health', () => {
	it('returns ok', async () => {
		const app = createApp();
		const res = await app.request('/api/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});
