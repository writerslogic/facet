// Client-side feature flags. Unlike experiments (which bucket locally), flags evaluate on the server
// via POST /api/flags/eval so the FULL targeting ruleset — which is deliberately NOT shipped to the
// browser — is applied by the ONE shared evaluator. The browser sends only its stable local id (the
// same `facet.exp` used for experiments, never identity) plus non-identifying context; the response
// is a map of { variant, participating, reason } per flag, cached for the page. Opt-out and GPC are
// honored: an opted-out visitor is never evaluated and every flag reads as its safe default. Zero
// runtime deps beyond the shared assignment type. Kept out of the drop-in script bundle by design.

import type { FlagAssignment } from '@facet/shared';
import { localId } from './id.js';
import { getConfig } from './index.js';
import { isOptedOut } from './optout.js';

type Assignments = Record<string, FlagAssignment>;

const OPTED_OUT: FlagAssignment = {
	variant: '',
	participating: false,
	reason: 'opted-out',
};
const PENDING: FlagAssignment = {
	variant: '',
	participating: false,
	reason: 'pending',
};
const UNKNOWN: FlagAssignment = {
	variant: '',
	participating: false,
	reason: 'unknown',
};

let assignments: Assignments | null = null;
let fetching = false;

let readyPromise: Promise<void> | null = null;
let resolveReady: (() => void) | null = null;

function ensureReadyPromise(): Promise<void> {
	if (!readyPromise) {
		readyPromise = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
	}
	return readyPromise;
}

function settleReady(): void {
	if (resolveReady) {
		resolveReady();
		resolveReady = null;
	}
}

/** Non-identifying context the browser can supply for targeting. Country/device are set authoritatively
 * by the server (a browser can't know geo and could spoof it), so they are intentionally omitted here. */
function browserCtx(): Record<string, string> {
	const ctx: Record<string, string> = {};
	if (typeof location !== 'undefined') {
		ctx.path = location.pathname;
		ctx.host = location.hostname;
	}
	if (typeof navigator !== 'undefined' && navigator.language) {
		ctx.lang = navigator.language;
	}
	return ctx;
}

/** Fetch and cache all flag assignments for this visitor once. Settles readiness on success OR failure. */
function loadFlags(): void {
	if (assignments !== null || fetching) return;
	// Opted out: never evaluate. Readiness still settles so whenFlagsReady() resolves.
	if (isOptedOut()) {
		assignments = {};
		settleReady();
		return;
	}
	const config = getConfig();
	if (!config || typeof fetch === 'undefined') return;
	fetching = true;
	fetch(`${config.host}/api/flags/eval`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			site_id: config.siteId,
			id: localId(),
			ctx: browserCtx(),
		}),
	})
		.then((r) => r.json())
		.then((body: { flags?: Assignments }) => {
			assignments = body.flags ?? {};
		})
		.catch(() => {
			assignments = {};
		})
		.finally(() => {
			settleReady();
		});
}

/**
 * Resolve after the flag evaluation request settles (success OR failure). Never rejects. Repeated calls
 * return the same stable promise; safe to call before init(). Await this to avoid a first-paint flash of
 * default values before assignments have loaded.
 */
export function whenFlagsReady(): Promise<void> {
	const p = ensureReadyPromise();
	loadFlags();
	return p;
}

/**
 * The full assignment for `flagKey`: `{ variant, participating, reason }`. `reason` is `'opted-out'`
 * (never evaluated), `'pending'` (not loaded yet — await whenFlagsReady), `'unknown'` (no such flag),
 * `'gpc'`/`'disabled'`/`'rollout'`/`rule:<n>` from the server. `participating` is true only for a
 * genuine bucketed assignment.
 */
export function flagAssignment(flagKey: string): FlagAssignment {
	if (isOptedOut()) return OPTED_OUT;
	loadFlags();
	if (assignments === null) return PENDING;
	return assignments[flagKey] ?? UNKNOWN;
}

/** The assigned variant key for `flagKey`, or `''` when opted-out / pending / unknown. */
export function flag(flagKey: string): string {
	return flagAssignment(flagKey).variant;
}

/** Convenience for boolean flags: true only when the assigned variant is `on`. Opt-out/pending → false
 * (features default OFF), the privacy- and safety-conservative choice. */
export function flagBool(flagKey: string): boolean {
	return flag(flagKey) === 'on';
}

/** All loaded assignments (empty until whenFlagsReady() resolves; empty when opted out). */
export function allFlags(): Assignments {
	loadFlags();
	return assignments ?? {};
}
