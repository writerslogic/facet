// Per-site persistence for the bento layout. The board is a list of slots (tile id + size); the user's
// arrangement lives in localStorage keyed by site so each property keeps its own dashboard. Unknown tile
// ids (from an older saved layout) are dropped on load so a renamed/removed tile can't break the board.

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_LAYOUT, SIZES, type Slot, TILE_REGISTRY, newSlotUid } from './tiles.js';

const KEY = (siteId: string): string => `facet.board.${siteId}`;
const LAYOUT_EVENT = 'facet:board-layout';

interface LayoutEventDetail {
	siteId: string;
	slots: Slot[];
}

function announceLayout(siteId: string, slots: Slot[]): void {
	window.dispatchEvent(
		new CustomEvent<LayoutEventDetail>(LAYOUT_EVENT, { detail: { siteId, slots } }),
	);
}

function sanitize(slots: unknown): Slot[] | null {
	if (!Array.isArray(slots)) return null;
	// Drop slots whose tile id or size is not a value the current build knows about, so an older or
	// hand-edited layout can never render an unknown tile or an undefined grid span (a collapsed cell).
	const clean = slots.filter(
		(s): s is Slot =>
			typeof s === 'object' &&
			s !== null &&
			typeof (s as Slot).tileId === 'string' &&
			(s as Slot).tileId in TILE_REGISTRY &&
			typeof (s as Slot).size === 'string' &&
			(s as Slot).size in SIZES,
	);
	if (clean.length === 0) return null;
	// Backfill/repair uids: layouts saved before slots had ids, or with a duplicated id, get a fresh one
	// so React keys stay stable and unique (otherwise reorder would remount tiles).
	const seen = new Set<string>();
	return clean.map((s) => {
		let uid =
			typeof s.uid === 'string' && s.uid && !seen.has(s.uid) ? s.uid : newSlotUid(s.tileId);
		while (seen.has(uid)) uid = newSlotUid(s.tileId);
		seen.add(uid);
		// Keep a plain-object config (per-instance chart style + options); drop anything malformed.
		const config =
			s.config && typeof s.config === 'object' && !Array.isArray(s.config)
				? s.config
				: undefined;
		return { ...s, uid, config };
	});
}

const PREFS_KEY = (siteId: string): string => `facet.boardPrefs.${siteId}`;

/** Per-site board preferences. `scroll` off keeps the resting Overview at a glance; editing and an
 * explicit Show more disclosure still render the complete layout in a board-owned scroller. */
export interface BoardPrefs {
	scroll: boolean;
}

const DEFAULT_PREFS: BoardPrefs = { scroll: false };

export function readBoardPrefs(siteId: string): BoardPrefs {
	try {
		const raw = localStorage.getItem(PREFS_KEY(siteId));
		if (!raw) return DEFAULT_PREFS;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS;
		const scroll = (parsed as Partial<BoardPrefs>).scroll;
		return { scroll: typeof scroll === 'boolean' ? scroll : false };
	} catch {
		return DEFAULT_PREFS;
	}
}

/** Board preferences for a site plus a setter. Persists immediately; falls back to in-memory state when
 * storage is unavailable, the same way useBoardLayout does. */
export function useBoardPrefs(siteId: string): {
	prefs: BoardPrefs;
	setPrefs: (next: BoardPrefs) => void;
} {
	const [prefs, setPrefsState] = useState<BoardPrefs>(() => readBoardPrefs(siteId));

	useEffect(() => {
		setPrefsState(readBoardPrefs(siteId));
	}, [siteId]);

	const setPrefs = useCallback(
		(next: BoardPrefs) => {
			setPrefsState(next);
			try {
				localStorage.setItem(PREFS_KEY(siteId), JSON.stringify(next));
			} catch {
				// Private-mode / quota: keep the in-memory preference, just don't persist it.
			}
		},
		[siteId],
	);

	return { prefs, setPrefs };
}

/** The persisted (or default) layout for a site, without the hook — for the loading skeleton. */
export function readBoardLayout(siteId: string): Slot[] {
	try {
		const raw = localStorage.getItem(KEY(siteId));
		if (!raw) return DEFAULT_LAYOUT;
		return sanitize(JSON.parse(raw)) ?? DEFAULT_LAYOUT;
	} catch {
		return DEFAULT_LAYOUT;
	}
}

/** The board layout for a site plus mutators. Every change persists immediately. `reset` restores the
 * shipped default. State re-seeds when the active site changes. */
export function useBoardLayout(siteId: string): {
	slots: Slot[];
	setSlots: (next: Slot[]) => void;
	reset: () => void;
} {
	const [slots, setSlotsState] = useState<Slot[]>(() => readBoardLayout(siteId));

	useEffect(() => {
		setSlotsState(readBoardLayout(siteId));
		const onLayout = (event: Event): void => {
			const detail = (event as CustomEvent<LayoutEventDetail>).detail;
			if (detail.siteId === siteId) setSlotsState(detail.slots);
		};
		window.addEventListener(LAYOUT_EVENT, onLayout);
		return () => window.removeEventListener(LAYOUT_EVENT, onLayout);
	}, [siteId]);

	const setSlots = useCallback(
		(next: Slot[]) => {
			setSlotsState(next);
			announceLayout(siteId, next);
			try {
				localStorage.setItem(KEY(siteId), JSON.stringify(next));
			} catch {
				// Private-mode / quota: keep the in-memory arrangement, just don't persist it.
			}
		},
		[siteId],
	);

	const reset = useCallback(() => {
		setSlotsState(DEFAULT_LAYOUT);
		announceLayout(siteId, DEFAULT_LAYOUT);
		try {
			localStorage.removeItem(KEY(siteId));
		} catch {
			// ignore
		}
	}, [siteId]);

	return { slots, setSlots, reset };
}
