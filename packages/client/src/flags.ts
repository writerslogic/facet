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

// REQUIRED: these mirror FlagEvalSchema's ctx bounds in packages/shared/src/schemas.ts. The server
// validates the WHOLE body and rejects it outright on any over-bound field, so one long path — which
// any inbound link controls — would otherwise silently default every flag on the page.
const PATH_MAX_LENGTH = 2048;
const HOST_MAX_LENGTH = 253;
const LANG_MAX_LENGTH = 35;

// A hung eval must not hold an awaited whenFlagsReady() open for the browser's own network timeout.
// Readiness settles here; a response that lands later still populates the cache.
const EVAL_TIMEOUT_MS = 5_000;

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

const EMPTY: Assignments = Object.freeze(Object.create(null));

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
		if (location.pathname) ctx.path = location.pathname.slice(0, PATH_MAX_LENGTH);
		if (location.hostname) ctx.host = location.hostname.slice(0, HOST_MAX_LENGTH);
	}
	if (typeof navigator !== 'undefined' && navigator.language) {
		ctx.lang = navigator.language.slice(0, LANG_MAX_LENGTH);
	}
	return ctx;
}

/** IMPORTANT: the response is untrusted. Only well-formed entries survive, so nothing typed as a
 * FlagAssignment can reach a caller malformed, and the null-prototype map keeps a key like `toString`
 * — or a `__proto__` key, which JSON.parse makes an ordinary own property — from resolving at all. */
function normalize(raw: unknown): Assignments {
	const out: Assignments = Object.create(null);
	if (!raw || typeof raw !== 'object') return out;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== 'object') continue;
		const a = value as Partial<FlagAssignment>;
		if (typeof a.variant !== 'string' || typeof a.reason !== 'string') continue;
		out[key] = {
			variant: a.variant,
			participating: a.participating === true,
			reason: a.reason,
		};
	}
	return out;
}

/** Fetch and cache all flag assignments for this visitor once. Settles readiness on success OR failure. */
function loadFlags(): void {
	if (assignments !== null || fetching) return;
	// Opted out: never evaluate. `assignments` stays null (not `{}`) for the same reason as the
	// no-config path below — an opt-in later in this page load must still reach the real fetch.
	if (isOptedOut()) {
		settleReady();
		return;
	}
	const config = getConfig();
	if (!config || typeof fetch === 'undefined') {
		// `assignments` stays null (not `{}`): a later call — once init() has run — must still
		// fall through to the real fetch below rather than being short-circuited by the
		// `assignments !== null` guard above. Settling here only unblocks a whenFlagsReady()
		// awaited before init(), matching its documented "safe to call before init()" contract.
		settleReady();
		return;
	}
	fetching = true;
	const timer = setTimeout(() => {
		// Every flag reads 'unknown' once the gate has resolved, never 'pending' — a caller that did
		// await whenFlagsReady() must not be told to await it again. A late response still lands below.
		assignments = EMPTY;
		settleReady();
	}, EVAL_TIMEOUT_MS);
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
		.then((body: { flags?: unknown } | null) => {
			assignments = normalize(body?.flags);
		})
		.catch(() => {
			assignments = EMPTY;
		})
		.finally(() => {
			clearTimeout(timer);
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

/** All loaded assignments (empty until whenFlagsReady() resolves; empty when opted out). A copy, so a
 * caller cannot mutate the page cache every other flag read is served from. */
export function allFlags(): Assignments {
	loadFlags();
	return { ...(assignments ?? EMPTY) };
}
