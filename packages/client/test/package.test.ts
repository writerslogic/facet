// Package smoke test: the built ESM entry exposes the public API as callable functions. Skips (does
// not fail) when dist is absent so unit runs without a prior build still pass.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const built = existsSync(distEntry);

describe.skipIf(!built)('built package exports', () => {
	it('exposes track/init/variant/assignment/whenReady/optOut/optIn/isOptedOut as functions', async () => {
		const mod = (await import('../dist/index.js')) as Record<string, unknown>;
		for (const name of [
			'track',
			'init',
			'variant',
			'assignment',
			'whenReady',
			'optOut',
			'optIn',
			'isOptedOut',
		]) {
			expect(typeof mod[name]).toBe('function');
		}
	});
});
