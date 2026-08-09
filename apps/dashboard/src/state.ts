// Dashboard state: site credentials live in sessionStorage so closing the tab clears bearer keys.
// Non-secret presentation preferences may still use localStorage. Ranges are either a
// preset (24h/7d/30d/90d) or an explicit custom start/end. All timestamps are unix-ms treated as UTC.

import { subDays } from 'date-fns';
import {
	type ReactElement,
	type ReactNode,
	createContext,
	createElement,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from 'react';
import { DEMO_API_KEY, DEMO_LABEL, DEMO_SITE_ID, STATIC_DEMO } from './demo/constants.js';
import { randomId } from './lib/id.js';

export type RangePreset = '24h' | '7d' | '30d' | '90d';

export const RANGE_PRESETS: RangePreset[] = ['24h', '7d', '30d', '90d'];

const PROFILES_STORAGE = 'facet.profiles';
const ACTIVE_STORAGE = 'facet.activeProfile';
const LEGACY_KEY_STORAGE = 'facet.key';
const LEGACY_SITE_STORAGE = 'facet.site';

function storageGet(kind: 'local' | 'session', key: string): string | null {
	try {
		return (kind === 'local' ? localStorage : sessionStorage).getItem(key);
	} catch {
		return null;
	}
}

function storageSet(kind: 'local' | 'session', key: string, value: string): void {
	try {
		(kind === 'local' ? localStorage : sessionStorage).setItem(key, value);
	} catch {
		// Privacy modes and storage quotas may disable browser storage; keep the in-memory state usable.
	}
}

function storageRemove(kind: 'local' | 'session', key: string): void {
	try {
		(kind === 'local' ? localStorage : sessionStorage).removeItem(key);
	} catch {
		// Best effort: an inaccessible store cannot expose credentials to this page either.
	}
}

const PRESET_DAYS: Record<RangePreset, number> = {
	'24h': 1,
	'7d': 7,
	'30d': 30,
	'90d': 90,
};

/** Server-enforced maximum range width, in milliseconds (90 days). */
export const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Range {
	start: number;
	end: number;
}

/** The active range selection: a named preset, or an explicit custom window. */
export type RangeSelection =
	| { kind: 'preset'; preset: RangePreset }
	| { kind: 'custom'; start: number; end: number };

/** A saved site connection: a label, the site UUID, and its `clk_` API key. */
export interface Profile {
	id: string;
	label: string;
	siteId: string;
	apiKey: string;
}

/** Compute the { start, end } window for a preset ending at `now`. */
export function rangeForPreset(preset: RangePreset, now: number = Date.now()): Range {
	return { start: subDays(now, PRESET_DAYS[preset]).getTime(), end: now };
}

/** Resolve any selection to a concrete { start, end } window. */
export function resolveRange(selection: RangeSelection, now: number = Date.now()): Range {
	if (selection.kind === 'custom') return { start: selection.start, end: selection.end };
	return rangeForPreset(selection.preset, now);
}

/** The window of equal duration immediately preceding `range` (for period comparison). */
export function previousRange(range: Range): Range {
	const duration = range.end - range.start;
	return { start: range.start - duration, end: range.start };
}

/**
 * Validate a custom range. Returns an error message, or null when acceptable: start must be before
 * end, and the span must not exceed the 90-day server maximum.
 */
export function validateCustomRange(start: number, end: number): string | null {
	if (!Number.isFinite(start) || !Number.isFinite(end))
		return 'Enter a valid start and end date.';
	if (start >= end) return 'The start date must be before the end date.';
	if (end - start > MAX_RANGE_MS) return 'The range cannot exceed 90 days.';
	return null;
}

/** Parse a `YYYY-MM-DD` date-input value as a UTC day boundary. Returns NaN when unparseable. */
export function parseDateInput(value: string): number {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.NaN;
	return Date.parse(`${value}T00:00:00.000Z`);
}

/** Format a unix-ms timestamp as a `YYYY-MM-DD` UTC date-input value. */
export function formatDateInput(ms: number): string {
	if (!Number.isFinite(ms)) return '';
	return new Date(ms).toISOString().slice(0, 10);
}

function newId(): string {
	return `p-${randomId()}`;
}

/** The synthetic profile id for the public no-login demo. Stable so it's easy to detect (`isDemo`). */
const DEMO_PROFILE_ID = 'p-demo';

/**
 * The read-only demo profile, or null. Populated in two cases: the fully-static demo build
 * (`VITE_FACET_STATIC_DEMO=1`, backed by the in-browser mock — see `demo/mockApi.ts`), or a
 * Worker-backed demo build that sets `VITE_FACET_DEMO_SITE_ID` + `VITE_FACET_DEMO_API_KEY`. Every
 * self-hosted/AGPL build leaves all of these unset → null → the normal KeyGate flow is untouched. The
 * demo profile is never persisted to localStorage: it's a first-load default a visitor's own profile supersedes.
 */
function demoProfile(): Profile | null {
	if (STATIC_DEMO) {
		return {
			id: DEMO_PROFILE_ID,
			label: DEMO_LABEL,
			siteId: DEMO_SITE_ID,
			apiKey: DEMO_API_KEY,
		};
	}
	const siteId = import.meta.env.VITE_FACET_DEMO_SITE_ID;
	const apiKey = import.meta.env.VITE_FACET_DEMO_API_KEY;
	if (!siteId || !apiKey) return null;
	return {
		id: DEMO_PROFILE_ID,
		label: import.meta.env.VITE_FACET_DEMO_LABEL || DEMO_LABEL,
		siteId,
		apiKey,
	};
}

/** Initial profiles + active id: stored profiles if any, else the demo profile when this is the demo
 * build, else empty (→ KeyGate). Reads storage once so the provider's two initializers stay in sync. */
function initialProfileState(): { profiles: Profile[]; activeId: string } {
	const stored = readProfiles();
	if (stored.length > 0) return { profiles: stored, activeId: readActiveId(stored) };
	const demo = demoProfile();
	if (demo) return { profiles: [demo], activeId: demo.id };
	return { profiles: [], activeId: '' };
}

function readProfiles(): Profile[] {
	try {
		const raw = storageGet('session', PROFILES_STORAGE);
		if (raw) {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(p): p is Profile =>
						typeof p === 'object' &&
						p !== null &&
						typeof (p as Profile).id === 'string' &&
						typeof (p as Profile).siteId === 'string' &&
						typeof (p as Profile).apiKey === 'string',
				);
			}
		}
	} catch {
		// ignore malformed storage and fall through to migration.
	}

	// One-time migration removes credentials written by older releases from persistent storage.
	const legacyProfiles = storageGet('local', PROFILES_STORAGE);
	if (legacyProfiles) {
		try {
			storageSet('session', PROFILES_STORAGE, legacyProfiles);
			storageRemove('local', PROFILES_STORAGE);
			return readProfiles();
		} catch {
			return [];
		}
	}
	const legacyKey = storageGet('local', LEGACY_KEY_STORAGE);
	const legacySite = storageGet('local', LEGACY_SITE_STORAGE);
	if (legacyKey && legacySite) {
		const migrated: Profile = {
			id: newId(),
			label: legacySite,
			siteId: legacySite,
			apiKey: legacyKey,
		};
		storageSet('session', PROFILES_STORAGE, JSON.stringify([migrated]));
		storageSet('session', ACTIVE_STORAGE, migrated.id);
		storageRemove('local', LEGACY_KEY_STORAGE);
		storageRemove('local', LEGACY_SITE_STORAGE);
		return [migrated];
	}
	return [];
}

function persistProfiles(profiles: Profile[]): void {
	storageSet('session', PROFILES_STORAGE, JSON.stringify(profiles));
}

function readActiveId(profiles: Profile[]): string {
	const stored = storageGet('session', ACTIVE_STORAGE);
	if (stored && profiles.some((p) => p.id === stored)) return stored;
	return profiles[0]?.id ?? '';
}

/** Read the range selection from the URL. `range=custom&start=..&end=..` or `range=<preset>`. */
function readSelectionFromUrl(): RangeSelection {
	const params = new URLSearchParams(window.location.search);
	const raw = params.get('range');
	if (raw === 'custom') {
		const start = Number(params.get('start'));
		const end = Number(params.get('end'));
		if (Number.isFinite(start) && Number.isFinite(end) && !validateCustomRange(start, end)) {
			return { kind: 'custom', start, end };
		}
	}
	if (RANGE_PRESETS.includes(raw as RangePreset)) {
		return { kind: 'preset', preset: raw as RangePreset };
	}
	return { kind: 'preset', preset: '7d' };
}

function readCompareFromUrl(): boolean {
	return new URLSearchParams(window.location.search).get('compare') === '1';
}

function writeSelectionToUrl(selection: RangeSelection, compare: boolean): void {
	const url = new URL(window.location.href);
	if (selection.kind === 'custom') {
		url.searchParams.set('range', 'custom');
		url.searchParams.set('start', String(selection.start));
		url.searchParams.set('end', String(selection.end));
	} else {
		url.searchParams.set('range', selection.preset);
		url.searchParams.delete('start');
		url.searchParams.delete('end');
	}
	if (compare) url.searchParams.set('compare', '1');
	else url.searchParams.delete('compare');
	window.history.replaceState(null, '', url);
}

export interface DashboardStore {
	apiKey: string;
	siteId: string;
	profiles: Profile[];
	activeProfileId: string;
	activeProfile: Profile | null;
	/** True when the active profile is the public no-login demo (read-only; drives the demo banner). */
	isDemo: boolean;
	/** The active range selection (preset or custom). */
	selection: RangeSelection;
	/** Convenience: the active preset id, or null when a custom range is active. */
	preset: RangePreset | null;
	/** The resolved primary { start, end } window. */
	range: Range;
	/** Whether period comparison is enabled. */
	compare: boolean;
	/** The preceding-period window when compare is on, else null. */
	compareRange: Range | null;
	addProfile: (input: {
		label: string;
		siteId: string;
		apiKey: string;
	}) => Profile;
	updateProfile: (id: string, patch: Partial<Omit<Profile, 'id'>>) => void;
	removeProfile: (id: string) => void;
	setActiveProfile: (id: string) => void;
	setPreset: (preset: RangePreset) => void;
	setCustomRange: (start: number, end: number) => void;
	setCompare: (on: boolean) => void;
}

const DashboardContext = createContext<DashboardStore | null>(null);

export function DashboardProvider({
	children,
}: {
	children: ReactNode;
}): ReactElement {
	// initialProfileState() performs a one-time storage migration as a side effect (see readProfiles),
	// so it must run exactly once per mount, not once per useState initializer: two independent calls
	// could observe different storage states if the first call's migration write partially failed,
	// leaving `profiles` and `activeProfileId` seeded from two different snapshots.
	const initialStateRef = useRef<{ profiles: Profile[]; activeId: string } | null>(null);
	function getInitialState(): { profiles: Profile[]; activeId: string } {
		if (initialStateRef.current === null) {
			initialStateRef.current = initialProfileState();
		}
		return initialStateRef.current;
	}
	const [profiles, setProfiles] = useState<Profile[]>(() => getInitialState().profiles);
	const [activeProfileId, setActiveProfileId] = useState<string>(
		() => getInitialState().activeId,
	);
	const [selection, setSelectionState] = useState<RangeSelection>(readSelectionFromUrl);
	const [compare, setCompareState] = useState<boolean>(readCompareFromUrl);

	const addProfile = useCallback((input: { label: string; siteId: string; apiKey: string }) => {
		const profile: Profile = { id: newId(), ...input };
		setProfiles((prev) => {
			const next = [...prev, profile];
			persistProfiles(next);
			return next;
		});
		storageSet('session', ACTIVE_STORAGE, profile.id);
		setActiveProfileId(profile.id);
		return profile;
	}, []);

	const updateProfile = useCallback((id: string, patch: Partial<Omit<Profile, 'id'>>) => {
		setProfiles((prev) => {
			const next = prev.map((p) => (p.id === id ? { ...p, ...patch } : p));
			persistProfiles(next);
			return next;
		});
	}, []);

	const removeProfile = useCallback((id: string) => {
		setProfiles((prev) => {
			const next = prev.filter((p) => p.id !== id);
			persistProfiles(next);
			setActiveProfileId((current) => {
				if (current !== id) return current;
				const fallback = next[0]?.id ?? '';
				if (fallback) storageSet('session', ACTIVE_STORAGE, fallback);
				else storageRemove('session', ACTIVE_STORAGE);
				return fallback;
			});
			return next;
		});
	}, []);

	const setActiveProfile = useCallback((id: string) => {
		storageSet('session', ACTIVE_STORAGE, id);
		setActiveProfileId(id);
	}, []);

	const setPreset = useCallback((next: RangePreset) => {
		const sel: RangeSelection = { kind: 'preset', preset: next };
		setSelectionState(sel);
		setCompareState((c) => {
			writeSelectionToUrl(sel, c);
			return c;
		});
	}, []);

	const setCustomRange = useCallback((start: number, end: number) => {
		const sel: RangeSelection = { kind: 'custom', start, end };
		setSelectionState(sel);
		setCompareState((c) => {
			writeSelectionToUrl(sel, c);
			return c;
		});
	}, []);

	const setCompare = useCallback((on: boolean) => {
		setCompareState(on);
		setSelectionState((sel) => {
			writeSelectionToUrl(sel, on);
			return sel;
		});
	}, []);

	const activeProfile = useMemo(
		() => profiles.find((p) => p.id === activeProfileId) ?? null,
		[profiles, activeProfileId],
	);

	// Presets are re-anchored to "now" on each render so a long-lived tab keeps a rolling window; a
	// custom range is a fixed window. A stats query key includes this range object, so recomputing it
	// per render is intentional (it drives refetch-on-change).
	const range = resolveRange(selection);
	const compareRange = compare ? previousRange(range) : null;

	const store: DashboardStore = {
		apiKey: activeProfile?.apiKey ?? '',
		siteId: activeProfile?.siteId ?? '',
		profiles,
		activeProfileId,
		activeProfile,
		isDemo: activeProfile?.id === DEMO_PROFILE_ID,
		selection,
		preset: selection.kind === 'preset' ? selection.preset : null,
		range,
		compare,
		compareRange,
		addProfile,
		updateProfile,
		removeProfile,
		setActiveProfile,
		setPreset,
		setCustomRange,
		setCompare,
	};

	return createElement(DashboardContext.Provider, { value: store }, children);
}

export function useDashboard(): DashboardStore {
	const store = useContext(DashboardContext);
	if (!store) throw new Error('useDashboard must be used within DashboardProvider');
	return store;
}

export { DAY_MS };
