// Dashboard state: multiple site profiles { id, label, siteId, apiKey } persisted in localStorage
// with an active-profile pointer, plus the selected date range (in the URL). Ranges are either a
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
	useState,
} from 'react';

export type RangePreset = '24h' | '7d' | '30d' | '90d';

export const RANGE_PRESETS: RangePreset[] = ['24h', '7d', '30d', '90d'];

const PROFILES_STORAGE = 'facet.profiles';
const ACTIVE_STORAGE = 'facet.activeProfile';
const LEGACY_KEY_STORAGE = 'facet.key';
const LEGACY_SITE_STORAGE = 'facet.site';

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
	return typeof crypto !== 'undefined' && crypto.randomUUID
		? crypto.randomUUID()
		: `p-${Math.random().toString(36).slice(2)}`;
}

function readProfiles(): Profile[] {
	try {
		const raw = localStorage.getItem(PROFILES_STORAGE);
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

	const legacyKey = localStorage.getItem(LEGACY_KEY_STORAGE);
	const legacySite = localStorage.getItem(LEGACY_SITE_STORAGE);
	if (legacyKey && legacySite) {
		const migrated: Profile = {
			id: newId(),
			label: legacySite,
			siteId: legacySite,
			apiKey: legacyKey,
		};
		localStorage.setItem(PROFILES_STORAGE, JSON.stringify([migrated]));
		localStorage.setItem(ACTIVE_STORAGE, migrated.id);
		localStorage.removeItem(LEGACY_KEY_STORAGE);
		localStorage.removeItem(LEGACY_SITE_STORAGE);
		return [migrated];
	}
	return [];
}

function persistProfiles(profiles: Profile[]): void {
	localStorage.setItem(PROFILES_STORAGE, JSON.stringify(profiles));
}

function readActiveId(profiles: Profile[]): string {
	const stored = localStorage.getItem(ACTIVE_STORAGE);
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
	const [profiles, setProfiles] = useState<Profile[]>(readProfiles);
	const [activeProfileId, setActiveProfileId] = useState<string>(() =>
		readActiveId(readProfiles()),
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
		localStorage.setItem(ACTIVE_STORAGE, profile.id);
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
				if (fallback) localStorage.setItem(ACTIVE_STORAGE, fallback);
				else localStorage.removeItem(ACTIVE_STORAGE);
				return fallback;
			});
			return next;
		});
	}, []);

	const setActiveProfile = useCallback((id: string) => {
		localStorage.setItem(ACTIVE_STORAGE, id);
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
