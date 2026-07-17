// Client-side A/B variant assignment. Privacy-first: bucketing is computed locally from a random id
// in localStorage (`facet.exp`) that is NEVER sent to the server as identity. The server only
// receives an aggregate `$exposure` event carrying { flag, variant }. Zero dependencies.

import { getConfig, track } from './index.js';
import { isOptedOut, safeGet, safeSet } from './optout.js';

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

const STORAGE_KEY = 'facet.exp';
const CONTROL = 'control';

let flags: FlagDef[] | null = null;
let fetching = false;
const exposed = new Set<string>();

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
	if (!config || typeof fetch === 'undefined') return;
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

/** Read (or lazily create) the stable local experiment id. Falls back gracefully without storage. */
function localId(): string {
	const existing = safeGet(STORAGE_KEY);
	if (existing) return existing;
	const id = randomHex();
	safeSet(STORAGE_KEY, id);
	return id;
}

/** 16 hex chars from crypto if available, else a Math.random fallback. */
function randomHex(): string {
	const bytes = new Uint8Array(8);
	if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
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
	if (!exposed.has(flagKey)) {
		exposed.add(flagKey);
		track('$exposure', { flag: flagKey, variant: chosen });
	}
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
