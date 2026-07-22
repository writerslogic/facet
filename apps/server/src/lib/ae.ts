import type { Env } from '../env.js';

export interface PerfSample {
	readonly siteId: string;
	readonly hostname: string;
	readonly path: string;
	readonly metric: string;
	readonly value: number;
}

export function writePerf(env: Env, sample: PerfSample): void {
	// The AE binding is on the post-v1 scale path (absent today); no-op rather than throw when unbound.
	if (!env.AE) {
		return;
	}
	env.AE.writeDataPoint({
		indexes: [sample.siteId],
		blobs: [sample.hostname, sample.path, sample.metric],
		doubles: [sample.value],
	});
}
