// The drop-in script bundle must stay tiny: reads the built dist/script.js, gzips it, and asserts
// the byte length is within budget. Skips when the artifact is absent so unit runs still pass.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

// 2.375 KiB: 2 KiB → 2.25 KiB for revenue + segmentation tracking, then to here for ack-deferred
// exposure commits. That last one buys a correctness property the bytes cannot be had without: an
// `$exposure` must go over fetch rather than sendBeacon to learn whether the SERVER accepted it,
// because committing the dedupe marker on a queued-but-dropped beacon silently under-counts one
// experiment arm forever. Measured cost at the time of the raise: 2382 B.
// Trim toward 2 KiB again if it approaches this ceiling.
const BUDGET_BYTES = 2432;
const scriptPath = fileURLToPath(new URL('../dist/script.js', import.meta.url));
const built = existsSync(scriptPath);

describe.skipIf(!built)('script.js size budget', () => {
	it(`gzips to <= ${BUDGET_BYTES} bytes`, () => {
		const gz = gzipSync(readFileSync(scriptPath));
		expect(gz.byteLength).toBeLessThanOrEqual(BUDGET_BYTES);
	});
});
