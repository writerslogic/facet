// The drop-in script bundle must stay tiny: reads the built dist/script.js, gzips it, and asserts
// the byte length is within budget. Skips when the artifact is absent so unit runs still pass.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const BUDGET_BYTES = 2048;
const scriptPath = fileURLToPath(new URL('../dist/script.js', import.meta.url));
const built = existsSync(scriptPath);

describe.skipIf(!built)('script.js size budget', () => {
	it(`gzips to <= ${BUDGET_BYTES} bytes`, () => {
		const gz = gzipSync(readFileSync(scriptPath));
		expect(gz.byteLength).toBeLessThanOrEqual(BUDGET_BYTES);
	});
});
