// Dashboard state: API key + site id (from localStorage) and the selected date-range preset
// (persisted in the URL). The derived { start, end } window is recomputed on each render so
// `end` tracks "now" for the active preset.

import { subDays } from 'date-fns';
import {
	type ReactElement,
	type ReactNode,
	createContext,
	createElement,
	useCallback,
	useContext,
	useState,
} from 'react';

export type RangePreset = '24h' | '7d' | '30d' | '90d';

export const RANGE_PRESETS: RangePreset[] = ['24h', '7d', '30d', '90d'];

const KEY_STORAGE = 'countless.key';
const SITE_STORAGE = 'countless.site';

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

/** Compute the { start, end } window for a preset ending at `now`. */
export function rangeForPreset(preset: RangePreset, now: number = Date.now()): Range {
	return { start: subDays(now, PRESET_DAYS[preset]).getTime(), end: now };
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
	apiKey: string;
	siteId: string;
	preset: RangePreset;
	range: Range;
	setCredentials: (apiKey: string, siteId: string) => void;
	clearCredentials: () => void;
	setPreset: (preset: RangePreset) => void;
}

const DashboardContext = createContext<DashboardStore | null>(null);

export function DashboardProvider({
	children,
}: {
	children: ReactNode;
}): ReactElement {
	const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(KEY_STORAGE) ?? '');
	const [siteId, setSiteId] = useState<string>(() => localStorage.getItem(SITE_STORAGE) ?? '');
	const [preset, setPresetState] = useState<RangePreset>(readPresetFromUrl);

	const setCredentials = useCallback((nextKey: string, nextSite: string) => {
		localStorage.setItem(KEY_STORAGE, nextKey);
		localStorage.setItem(SITE_STORAGE, nextSite);
		setApiKey(nextKey);
		setSiteId(nextSite);
	}, []);

	const clearCredentials = useCallback(() => {
		localStorage.removeItem(KEY_STORAGE);
		localStorage.removeItem(SITE_STORAGE);
		setApiKey('');
		setSiteId('');
	}, []);

	const setPreset = useCallback((next: RangePreset) => {
		writePresetToUrl(next);
		setPresetState(next);
	}, []);

	const store: DashboardStore = {
		apiKey,
		siteId,
		preset,
		range: rangeForPreset(preset),
		setCredentials,
		clearCredentials,
		setPreset,
	};

	return createElement(DashboardContext.Provider, { value: store }, children);
}

export function useDashboard(): DashboardStore {
	const store = useContext(DashboardContext);
	if (!store) throw new Error('useDashboard must be used within DashboardProvider');
	return store;
}
