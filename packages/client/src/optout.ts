// Single source of truth for visitor opt-out state, consulted by every collection path. Honors
// Do-Not-Track and Global Privacy Control by default, a `data-facet-optout` script attribute, and a persistent
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

/** True when any Do-Not-Track or Global Privacy Control signal is set across common browser vendors. */
function browserSignalOptOut(): boolean {
	if (typeof navigator !== 'undefined') {
		// Global Privacy Control: a legally recognized opt-out signal (navigator.globalPrivacyControl).
		if (
			(navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl ===
			true
		)
			return true;
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
 * Whether the visitor is opted out of INDIVIDUAL tracking / personalization (experiments, flags).
 * Precedence (highest first):
 *   1. localStorage['facet.optout'] explicit value ('1'/'true' out, '0'/'false' in) — the
 *      visitor's persistent choice, which OVERRIDES DNT because it is deliberate and per-visitor.
 *   2. data-facet-optout script attribute.
 *   3. Do-Not-Track and Global Privacy Control browser signals.
 *   4. Default: opted in.
 */
export function isOptedOut(): boolean {
	const stored = safeGet(OPTOUT_KEY);
	if (stored === '1' || stored === 'true') return true;
	if (stored === '0' || stored === 'false') return false;
	if (scriptOptOut()) return true;
	return browserSignalOptOut();
}

/**
 * Whether the visitor made a DELIBERATE opt-out choice — the localStorage kill switch or the
 * `data-facet-optout` script attribute. This is the gate for anonymous pageview/event counting, and
 * unlike isOptedOut() it does NOT treat the passive Do-Not-Track / Global Privacy Control browser
 * signal as opt-out. Those signals govern the sale/sharing of PERSONAL data; a cookieless, aggregate
 * pageview carries none, so counting it keeps total-traffic figures accurate while staying privacy-first
 * (the Plausible/Fathom model). An explicit localStorage opt-in ('0'/'false') is honored as opted-in.
 */
export function isExplicitlyOptedOut(): boolean {
	const stored = safeGet(OPTOUT_KEY);
	if (stored === '1' || stored === 'true') return true;
	if (stored === '0' || stored === 'false') return false;
	return scriptOptOut();
}

/** Persist a visitor opt-out. Takes effect immediately for every collection path. */
export function optOut(): void {
	safeSet(OPTOUT_KEY, '1');
}

/** Persist an explicit opt-in. Overrides Do-Not-Track for this visitor. */
export function optIn(): void {
	safeSet(OPTOUT_KEY, '0');
}
