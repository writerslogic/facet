// Public API for the `countless` npm package: the programmatic `track()` entrypoint and
// config. Zero dependencies.

import type { EventProps } from '@countless/shared';

export interface CountlessConfig {
	/** Collect endpoint origin, e.g. "https://analytics.example.com". */
	host: string;
	/** Site UUID. */
	siteId: string;
}

let _config: CountlessConfig | undefined;

function parseUtmFromSearch(search: string): Record<string, string> | undefined {
	const params = new URLSearchParams(search);
	const source = params.get('utm_source') ?? undefined;
	const medium = params.get('utm_medium') ?? undefined;
	const campaign = params.get('utm_campaign') ?? undefined;
	if (source === undefined && medium === undefined && campaign === undefined) return undefined;
	const utm: Record<string, string> = {};
	if (source !== undefined) utm['source'] = source;
	if (medium !== undefined) utm['medium'] = medium;
	if (campaign !== undefined) utm['campaign'] = campaign;
	return utm;
}

/** Track a pageview (no name) or a named custom event. */
export function track(_name?: string, _props?: EventProps): void {
	if (!_config) return;
	const { host, siteId } = _config;
	const url = typeof location !== 'undefined' ? location.href : '';
	const referrer = typeof document !== 'undefined' ? document.referrer : undefined;
	const search = typeof location !== 'undefined' ? location.search : '';
	const utm = parseUtmFromSearch(search);

	const payload: Record<string, unknown> = {
		siteId,
		url,
		...(referrer ? { referrer } : {}),
		...(_name ? { name: _name } : {}),
		...(_props ? { props: _props } : {}),
		...(utm ? { utm } : {}),
	};

	const endpoint = `${host}/api/collect`;
	const body = JSON.stringify(payload);
	if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
		navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
	} else {
		fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => undefined);
	}
}

/** Configure the tracker (host + site id). Called by the auto-init shim. */
export function init(_config_: CountlessConfig): void {
	_config = _config_;
}
