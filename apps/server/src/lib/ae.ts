// Analytics Engine write half: emit performance samples to the `AE` dataset binding.

import type { Env } from '../env.js';

/** A single performance sample destined for the Analytics Engine dataset. */
export interface PerfSample {
	readonly siteId: string;
	readonly hostname: string;
	readonly path: string;
	readonly metric: string;
	readonly value: number;
}

/**
 * Write one performance data point to Analytics Engine.
 *
 * Datapoint shape is fixed:
 *   indexes: [siteId]
 *   blobs:   [hostname, path, metric]
 *   doubles: [value]
 */
export function writePerf(env: Env, sample: PerfSample): void {
	env.AE.writeDataPoint({
		indexes: [sample.siteId],
		blobs: [sample.hostname, sample.path, sample.metric],
		doubles: [sample.value],
	});
}
