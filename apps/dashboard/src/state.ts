// Dashboard state: multiple site profiles { id, label, siteId, apiKey } persisted in localStorage
// (key `facet.profiles`) with an active-profile pointer, plus the selected date-range preset (in the
// URL). Legacy single-site creds (`facet.key`/`facet.site`) are migrated into a profile on first load.
// The ADMIN_TOKEN is NEVER stored here — it lives only in Settings' sessionStorage/memory store.

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
// Legacy single-site keys, migrated on first load.
const LEGACY_KEY_STORAGE = 'facet.key';
const LEGACY_SITE_STORAGE = 'facet.site';

const PRESET_DAYS: Record<RangePreset, number> = {
	'24h': 1,
	'7d': 7,
	'30d': 30,
	'90d': 90,
};

export interface Range {
	start: number;
	end: number;
}

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

function newId(): string {
	return typeof crypto !== 'undefined' && crypto.randomUUID
		? crypto.randomUUID()
		: `p-${Math.random().toString(36).slice(2)}`;
}

/** Parse the persisted profile list, tolerating malformed storage. */
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

	// Migrate legacy single-site creds into a profile so current users don't lose access.
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

function readPresetFromUrl(): RangePreset {
	const raw = new URLSearchParams(window.location.search).get('range');
	return RANGE_PRESETS.includes(raw as RangePreset) ? (raw as RangePreset) : '7d';
}

function writePresetToUrl(preset: RangePreset): void {
	const url = new URL(window.location.href);
	url.searchParams.set('range', preset);
	window.history.replaceState(null, '', url);
}

export interface DashboardStore {
	/** Active profile's API key (empty string when no profile). */
	apiKey: string;
	/** Active profile's site id (empty string when no profile). */
	siteId: string;
	profiles: Profile[];
	activeProfileId: string;
	activeProfile: Profile | null;
	preset: RangePreset;
	range: Range;
	/** Create a profile and make it active. Returns the new profile. */
	addProfile: (input: {
		label: string;
		siteId: string;
		apiKey: string;
	}) => Profile;
	updateProfile: (id: string, patch: Partial<Omit<Profile, 'id'>>) => void;
	removeProfile: (id: string) => void;
	setActiveProfile: (id: string) => void;
	setPreset: (preset: RangePreset) => void;
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
	const [preset, setPresetState] = useState<RangePreset>(readPresetFromUrl);

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
		writePresetToUrl(next);
		setPresetState(next);
	}, []);

	const activeProfile = useMemo(
		() => profiles.find((p) => p.id === activeProfileId) ?? null,
		[profiles, activeProfileId],
	);

	const store: DashboardStore = {
		apiKey: activeProfile?.apiKey ?? '',
		siteId: activeProfile?.siteId ?? '',
		profiles,
		activeProfileId,
		activeProfile,
		preset,
		range: rangeForPreset(preset),
		addProfile,
		updateProfile,
		removeProfile,
		setActiveProfile,
		setPreset,
	};

	return createElement(DashboardContext.Provider, { value: store }, children);
}

export function useDashboard(): DashboardStore {
	const store = useContext(DashboardContext);
	if (!store) throw new Error('useDashboard must be used within DashboardProvider');
	return store;
}
