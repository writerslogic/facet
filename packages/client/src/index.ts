// Public API for the `countless` npm package: the programmatic `track()` entrypoint and
// config. Zero dependencies. Real beacon logic (sendBeacon + fetch fallback) lands in T012.

import type { EventProps } from '@countless/shared';

export interface CountlessConfig {
	/** Collect endpoint origin, e.g. "https://analytics.example.com". */
	host: string;
	/** Site UUID. */
	siteId: string;
}

/** Track a pageview (no name) or a named custom event. */
export function track(_name?: string, _props?: EventProps): void {
	return;
}

/** Configure the tracker (host + site id). Called by the auto-init shim. */
export function init(_config: CountlessConfig): void {
	return;
}
