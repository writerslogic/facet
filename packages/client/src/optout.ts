// Single source of truth for visitor opt-out state, consulted by every collection path. Honors
// Do-Not-Track by default, a `data-facet-optout` script attribute, and a persistent
// `localStorage['facet.optout']` kill switch (the visitor's deliberate control, which overrides
// DNT). All localStorage access is wrapped so a blocked/unavailable store never throws — it
// degrades to an in-memory map. State is re-read on every call so optOut()/optIn() take effect
// immediately. Zero dependencies.

const OPTOUT_KEY = 'facet.optout';

// In-memory fallback used whenever the real localStorage is unavailable (private mode, disabled,
// SecurityError). This keeps optOut()/optIn() functional without ever throwing.
const memoryStore = new Map<string, string>();

/** Read a key from localStorage, degrading to the in-memory store on any failure. */
export function safeGet(key: string): string | null {
	try {
		const v = localStorage.getItem(key);
		return v === null ? (memoryStore.has(key) ? (memoryStore.get(key) as string) : null) : v;
	} catch {
		return memoryStore.has(key) ? (memoryStore.get(key) as string) : null;
	}
}

/** Write a key to localStorage, mirroring to the in-memory store and never throwing. */
export function safeSet(key: string, value: string): void {
	memoryStore.set(key, value);
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage blocked/full: the in-memory mirror above keeps the value for this page load.
	}
}

// Values that mean "not opted out" when they appear in the script attribute or as a truthy check.
const FALSE_LIKE = new Set(['false', '0', 'no', 'off']);

/** The executing script element, when the auto bundle can find one. Set by auto.ts at boot. */
let scriptEl: { getAttribute(name: string): string | null } | null = null;

/** Record the executing <script> so the opt-out check can read its data-facet-optout attribute. */
export function setOptOutScript(el: { getAttribute(name: string): string | null } | null): void {
	scriptEl = el;
}

/** True when any Do-Not-Track signal is set across the common browser vendors. */
function dntEnabled(): boolean {
	if (typeof navigator !== 'undefined') {
		const dnt = navigator.doNotTrack;
		if (dnt === '1' || dnt === 'yes') return true;
		const ms = (navigator as unknown as { msDoNotTrack?: string }).msDoNotTrack;
		if (ms === '1') return true;
	}
	if (typeof window !== 'undefined') {
		const wdnt = (window as unknown as { doNotTrack?: string }).doNotTrack;
		if (wdnt === '1') return true;
	}
	return false;
}

/** True when the data-facet-optout script attribute is present and not a false-like value. */
function scriptOptOut(): boolean {
	const raw = scriptEl?.getAttribute('data-facet-optout');
	if (raw === null || raw === undefined) return false;
	return !FALSE_LIKE.has(raw.toLowerCase());
}

/**
 * Whether the visitor is opted out. Precedence (highest first):
 *   1. localStorage['facet.optout'] explicit value ('1'/'true' out, '0'/'false' in) — the
 *      visitor's persistent choice, which OVERRIDES DNT because it is deliberate and per-visitor.
 *   2. data-facet-optout script attribute.
 *   3. Do-Not-Track browser signals.
 *   4. Default: opted in.
 */
export function isOptedOut(): boolean {
	const stored = safeGet(OPTOUT_KEY);
	if (stored === '1' || stored === 'true') return true;
	if (stored === '0' || stored === 'false') return false;
	if (scriptOptOut()) return true;
	return dntEnabled();
}

/** Persist a visitor opt-out. Takes effect immediately for every collection path. */
export function optOut(): void {
	safeSet(OPTOUT_KEY, '1');
}

/** Persist an explicit opt-in. Overrides Do-Not-Track for this visitor. */
export function optIn(): void {
	safeSet(OPTOUT_KEY, '0');
}
