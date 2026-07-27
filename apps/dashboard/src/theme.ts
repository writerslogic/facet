// Theme store: the active palette + light/dark mode, persisted and applied to <html data-palette
// data-mode> so the CSS token layer (index.css) re-skins the whole app. Canvas (uPlot) and computed SVG
// colours can't read CSS vars, so `useThemeColors` resolves the active tokens to concrete strings.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export const PALETTES = ['prism', 'bio', 'aurora', 'fintech', 'cloudflare'] as const;
export type Palette = (typeof PALETTES)[number];
export type Mode = 'dark' | 'light';

export const PALETTE_LABELS: Record<Palette, string> = {
	prism: 'Prism',
	bio: 'Bioluminescent',
	aurora: 'Aurora',
	fintech: 'Deep FinTech',
	cloudflare: 'Cloudflare',
};

/** The three headline data hues per palette (dark values), for the Settings picker swatches. */
export const PALETTE_SWATCHES: Record<Palette, [string, string, string]> = {
	prism: ['#818cf8', '#c4b5fd', '#e879f9'],
	bio: ['#66fcf1', '#f000ff', '#45a29e'],
	aurora: ['#ff6b6b', '#ffd166', '#06d6a0'],
	fintech: ['#4d8fac', '#b5838d', '#81b29a'],
	cloudflare: ['#f6821f', '#3b82f6', '#00b3b3'],
};

export interface ThemeState {
	palette: Palette;
	mode: Mode;
}

const KEY = 'facet.theme';

function read(): ThemeState {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? '');
		if (PALETTES.includes(raw?.palette) && (raw?.mode === 'dark' || raw?.mode === 'light')) {
			return { palette: raw.palette, mode: raw.mode };
		}
	} catch {
		// fall through to default
	}
	return { palette: 'prism', mode: 'dark' };
}

let state: ThemeState = read();
const subscribers = new Set<() => void>();

function apply(): void {
	if (typeof document === 'undefined') return;
	const el = document.documentElement;
	el.dataset.palette = state.palette;
	el.dataset.mode = state.mode;
}

function commit(next: Partial<ThemeState>): void {
	state = { ...state, ...next };
	try {
		localStorage.setItem(KEY, JSON.stringify(state));
	} catch {
		// private mode / quota — keep the in-memory theme
	}
	apply();
	for (const fn of subscribers) fn();
}

/** Apply the persisted theme before first paint (call from the entry module). */
export function initTheme(): void {
	apply();
}

export function useTheme(): ThemeState & {
	setPalette: (p: Palette) => void;
	setMode: (m: Mode) => void;
} {
	const snap = useSyncExternalStore(
		(cb) => {
			subscribers.add(cb);
			return () => subscribers.delete(cb);
		},
		() => state,
		() => state,
	);
	const setPalette = useCallback((p: Palette) => commit({ palette: p }), []);
	const setMode = useCallback((m: Mode) => commit({ mode: m }), []);
	return { ...snap, setPalette, setMode };
}

export interface ThemeColors {
	d1: string;
	d2: string;
	d3: string;
	pos: string;
	neg: string;
	ink: string;
	muted: string;
	faint: string;
	/** Faint hairline colour (rgb()-wrapped) for chart grids/ticks. */
	grid: string;
	/** Categorical hues for flow ribbons / channels. */
	cat: string[];
}

function readColors(): ThemeColors {
	if (typeof document === 'undefined') {
		return {
			d1: '#818cf8',
			d2: '#c4b5fd',
			d3: '#e879f9',
			pos: '#34d399',
			neg: '#fb7185',
			ink: '#f5f4fb',
			muted: '#9ca3b8',
			faint: '#6b7192',
			grid: 'rgb(255 255 255 / 0.08)',
			cat: ['#6366f1', '#8b5cf6', '#d946ef', '#22d3ee', '#f59e0b', '#34d399'],
		};
	}
	const s = getComputedStyle(document.documentElement);
	// Fall back to the Prism-dark defaults when a token resolves empty (e.g. jsdom, or CSS not yet applied)
	// so canvas colours are never blank.
	const v = (n: string, fallback: string): string => s.getPropertyValue(n).trim() || fallback;
	return {
		d1: v('--d1', '#818cf8'),
		d2: v('--d2', '#c4b5fd'),
		d3: v('--d3', '#e879f9'),
		pos: v('--pos', '#34d399'),
		neg: v('--neg', '#fb7185'),
		ink: v('--ink', '#f5f4fb'),
		muted: v('--muted', '#9ca3b8'),
		faint: v('--faint', '#6b7192'),
		grid: `rgb(${v('--border', '255 255 255 / 0.08')})`,
		cat: [
			v('--c1', '#6366f1'),
			v('--c2', '#8b5cf6'),
			v('--c3', '#d946ef'),
			v('--c4', '#22d3ee'),
			v('--c5', '#f59e0b'),
			v('--c6', '#34d399'),
		],
	};
}

/** The active theme's colours as concrete strings, recomputed whenever palette/mode changes (after the
 * DOM attributes are applied), so canvas + interpolated-SVG renders can use them. */
export function useThemeColors(): ThemeColors {
	const { palette, mode } = useTheme();
	const [colors, setColors] = useState<ThemeColors>(readColors);
	// Re-read the computed tokens whenever the palette/mode changes; readColors is a stable module fn and
	// intentionally not a dependency.
	// biome-ignore lint/correctness/useExhaustiveDependencies: palette+mode are the only inputs; readColors reads the DOM they drive
	useEffect(() => {
		setColors(readColors());
	}, [palette, mode]);
	return colors;
}
