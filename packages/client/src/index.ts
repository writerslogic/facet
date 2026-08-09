// Public API for the `facet` npm package: the programmatic `track()` entrypoint and
// config. Zero dependencies.

import type { EventProps } from '@facet/shared';
import { isExplicitlyOptedOut } from './optout.js';

export interface FacetConfig {
	/** Collect endpoint origin, e.g. "https://analytics.example.com". */
	host: string;
	/** Site UUID. */
	siteId: string;
}

let Config: FacetConfig | undefined;

// Must match CollectPayloadSchema's utm.source/medium/campaign v.maxLength(200) in
// packages/shared/src/schemas.ts. The server validates the WHOLE payload and rejects it outright
// on any field over this bound (no per-field stripping), so an untruncated value from a
// programmatic ad-platform link doesn't reject a single field — it silently drops the pageview.
const UTM_MAX_LENGTH = 200;

function parseUtmFromSearch(search: string): Record<string, string> | undefined {
	const params = new URLSearchParams(search);
	const source = params.get('utm_source') ?? undefined;
	const medium = params.get('utm_medium') ?? undefined;
	const campaign = params.get('utm_campaign') ?? undefined;
	if (source === undefined && medium === undefined && campaign === undefined) return undefined;
	const utm: Record<string, string> = {};
	if (source !== undefined) utm.source = source.slice(0, UTM_MAX_LENGTH);
	if (medium !== undefined) utm.medium = medium.slice(0, UTM_MAX_LENGTH);
	if (campaign !== undefined) utm.campaign = campaign.slice(0, UTM_MAX_LENGTH);
	return utm;
}

/** Coarse viewport buckets computed ON-DEVICE — the raw resolution and DPR never leave the browser, so
 * no fingerprint-grade value is sent. The server allowlists exactly these tokens. */
function viewport(): { screen?: string; orientation?: string; dpr?: string } {
	if (typeof window === 'undefined') return {};
	const w = window.innerWidth || 0;
	const h = window.innerHeight || 0;
	if (!w) return {};
	const screen =
		w < 640
			? 'phone'
			: w < 1024
				? 'tablet'
				: w < 1536
					? 'laptop'
					: w < 2560
						? 'desktop'
						: 'ultrawide';
	const ratio = window.devicePixelRatio || 1;
	return {
		screen,
		orientation: w >= h ? 'landscape' : 'portrait',
		dpr: ratio >= 2.5 ? '3x' : ratio >= 1.5 ? '2x' : '1x',
	};
}

/** Track a pageview (no name) or a named custom event. */
export function track(_name?: string, _props?: EventProps): void {
	// Only a DELIBERATE opt-out suppresses the anonymous, cookieless pageview/event — a passive GPC/DNT
	// signal does not, so total traffic stays accurately counted (see isExplicitlyOptedOut).
	if (!Config || isExplicitlyOptedOut()) return;
	const { host, siteId } = Config;
	const hostname = typeof location !== 'undefined' ? location.hostname : '';
	const path = typeof location !== 'undefined' ? location.pathname : '/';
	const referrer = typeof document !== 'undefined' ? document.referrer : '';
	const search = typeof location !== 'undefined' ? location.search : '';
	const utm = parseUtmFromSearch(search);

	const payload: Record<string, unknown> = {
		site_id: siteId,
		hostname,
		path: path || '/',
		referrer: referrer ?? '',
		...(_name ? { name: _name } : {}),
		...(_props ? { props: _props } : {}),
		...(utm ? { utm } : {}),
		...viewport(),
	};

	const endpoint = `${host}/api/collect`;
	const body = JSON.stringify(payload);
	if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
		navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
	} else {
		fetch(endpoint, {
			method: 'POST',
			body,
			headers: { 'content-type': 'application/json' },
			keepalive: true,
		}).catch(() => undefined);
	}
}

/** Track an ecommerce purchase: a `purchase` event carrying revenue + currency (and any extra props).
 * The server lifts revenue/currency into typed columns for revenue reporting. */
export function purchase(revenue: number, currency = 'USD', props?: EventProps): void {
	track('purchase', { ...props, revenue, currency });
}

/** Configure the tracker (host + site id). Called by the auto-init shim. */
export function init(_config_: FacetConfig): void {
	Config = _config_;
}

/** The active config, or undefined before init(). Used by the experiments module. */
export function getConfig(): FacetConfig | undefined {
	return Config;
}

export { assignment, variant, whenReady } from './experiments.js';
export {
	allFlags,
	flag,
	flagAssignment,
	flagBool,
	whenFlagsReady,
} from './flags.js';
export { isOptedOut, optIn, optOut } from './optout.js';
