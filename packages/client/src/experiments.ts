// Client-side A/B variant assignment. Privacy-first: bucketing is computed locally from a random id
// in localStorage (`facet.exp`) that is NEVER sent to the server as identity. The server only
// receives an aggregate `$exposure` event carrying { flag, variant }. Zero dependencies.

import { localId } from './id.js';
import { getConfig, sendEvent } from './index.js';
import { isOptedOut } from './optout.js';

interface FlagDef {
	flag_key: string;
	variants: { key: string; weight: number }[];
}

/** Assignment status. `assigned` is the only genuine, participating bucketing. */
export type AssignmentStatus = 'assigned' | 'pending' | 'unavailable' | 'opted-out';

export interface Assignment {
	variant: string;
	participating: boolean;
	status: AssignmentStatus;
}

const CONTROL = 'control';

let flags: FlagDef[] | null = null;
let fetching = false;

// Exposure dedupe is committed only once the server acknowledges the `$exposure` beacon. Committing on
// send instead means a dropped exposure suppresses the retry that would have recorded it, and the
// experiment silently under-counts one arm.
const exposed = new Set<string>();
const inflight = new Set<string>();
const retryAt = new Map<string, number>();

// IMPORTANT: bounds concurrent in-flight exposures, so an unreachable collector cannot fan out one
// request per known flag at once. Flags past the cap are picked up by a later assignment() call.
const MAX_INFLIGHT_EXPOSURES = 32;

// IMPORTANT: the cap bounds concurrency, not RATE — recordExposure runs on every assignment()/variant()
// call, so against a dead collector a component resolving a variant each render would re-send per
// render. A failed send is held for this long; a first send is never delayed.
const EXPOSURE_RETRY_MS = 5_000;

/**
 * Send an `$exposure` once per flag, committing the dedupe marker only on a server ack.
 *
 * KISS: no retry queue. `assignment()` supplies `chosen` on every call and is the only caller, so a
 * failed exposure is retried by the next call that asks for the same flag — holding a copy of the
 * variant to replay later would buy nothing and cost the snippet bytes it has a budget for.
 */
function recordExposure(flagKey: string, chosen: string): void {
	if (exposed.has(flagKey) || inflight.has(flagKey)) return;
	const held = retryAt.get(flagKey);
	if (held !== undefined && held > Date.now()) return;
	if (inflight.size >= MAX_INFLIGHT_EXPOSURES) return;
	inflight.add(flagKey);
	void sendEvent('$exposure', { flag: flagKey, variant: chosen }, true).then((ok) => {
		inflight.delete(flagKey);
		if (ok) {
			exposed.add(flagKey);
			retryAt.delete(flagKey);
		} else retryAt.set(flagKey, Date.now() + EXPOSURE_RETRY_MS);
	});
}

// Readiness: a single promise that resolves once init has happened and the /active fetch settles
// (success OR failure). It never rejects. whenReady() hands out this stable promise; loadFlags()
// resolves it when the fetch completes, and it resolves immediately if there is nothing to fetch.
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

/**
 * Resolve after init and the experiments `/active` fetch have settled (success OR failure). Never
 * rejects. Repeated calls return the same stable promise; safe to call before init(). Gate
 * experiment-dependent rendering on this to avoid a first-paint control flash.
 */
export function whenReady(): Promise<void> {
	const p = ensureReadyPromise();
	loadFlags();
	return p;
}

/** Load active flag definitions once and cache them in a module var. */
function loadFlags(): void {
	if (flags !== null || fetching) return;
	// Opted out: never fetch or bucket. Readiness still settles so whenReady() resolves.
	if (isOptedOut()) {
		settleReady();
		return;
	}
	const config = getConfig();
	if (!config || typeof fetch === 'undefined') {
		// `flags` stays null: a later call — once init() has run — must still fall through to the
		// real fetch below rather than being short-circuited by the `flags !== null` guard above.
		// Settling here only unblocks a whenReady() awaited before init(), matching its documented
		// "safe to call before init()" contract.
		settleReady();
		return;
	}
	fetching = true;
	fetch(`${config.host}/api/experiments/active?site_id=${config.siteId}`)
		.then((r) => r.json())
		.then((body: { experiments?: FlagDef[] }) => {
			flags = body.experiments ?? [];
		})
		.catch(() => {
			flags = [];
		})
		.finally(() => {
			settleReady();
		});
}

/** Small deterministic FNV-1a-style string hash → unsigned 32-bit. */
function hashString(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Map the hash to a variant key using cumulative weights. */
function pick(def: FlagDef, id: string): string {
	const total = def.variants.reduce((sum, v) => sum + v.weight, 0);
	if (total <= 0) return def.variants[0]?.key ?? CONTROL;
	const point = (hashString(`${id}|${def.flag_key}`) / 0x100000000) * total;
	let acc = 0;
	for (const v of def.variants) {
		acc += v.weight;
		if (point < acc) return v.key;
	}
	return def.variants[def.variants.length - 1]?.key ?? CONTROL;
}

/** The known control/first variant for a loaded flag, or `'control'` when the flag is unknown. */
function fallbackVariant(flagKey: string): string {
	const def = flags?.find((f) => f.flag_key === flagKey);
	return def?.variants[0]?.key ?? CONTROL;
}

/**
 * Precise assignment for `flagKey`. Distinguishes a genuine bucketed assignment (`participating:
 * true`, status `assigned`) from `pending` (flags not loaded yet), `unavailable` (loaded but the
 * flag is unknown or has no variants), and `opted-out`. Only `assigned` fires an exposure (once
 * per flag per page load).
 */
export function assignment(flagKey: string): Assignment {
	if (isOptedOut()) {
		return {
			variant: fallbackVariant(flagKey),
			participating: false,
			status: 'opted-out',
		};
	}
	loadFlags();
	if (flags === null) {
		return {
			variant: fallbackVariant(flagKey),
			participating: false,
			status: 'pending',
		};
	}
	const def = flags.find((f) => f.flag_key === flagKey);
	if (!def || def.variants.length === 0) {
		return {
			variant: CONTROL,
			participating: false,
			status: 'unavailable',
		};
	}
	const chosen = pick(def, localId());
	recordExposure(flagKey, chosen);
	return { variant: chosen, participating: true, status: 'assigned' };
}

/**
 * Resolve the assigned variant for `flagKey`, backward-compatible (returns a variant key string).
 * When pending/unavailable/opted-out it returns a safe fallback (the flag's control/first variant
 * if known, else `'control'`) and does NOT fire an exposure. A fallback is NOT a confirmed
 * assignment: callers wanting to avoid a control flash should `await whenReady()` (or use
 * `assignment()`, whose `participating` flag is true only for a genuine bucketing).
 */
export function variant(flagKey: string): string {
	return assignment(flagKey).variant;
}
