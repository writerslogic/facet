// Per-site persistence for the bento layout. The board is a list of slots (tile id + size); the user's
// arrangement lives in localStorage keyed by site so each property keeps its own dashboard. Unknown tile
// ids (from an older saved layout) are dropped on load so a renamed/removed tile can't break the board.

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_LAYOUT, type Slot, TILE_REGISTRY } from './tiles.js';

const KEY = (siteId: string): string => `facet.board.${siteId}`;

function sanitize(slots: unknown): Slot[] | null {
	if (!Array.isArray(slots)) return null;
	const clean = slots.filter(
		(s): s is Slot =>
			typeof s === 'object' &&
			s !== null &&
			typeof (s as Slot).tileId === 'string' &&
			(s as Slot).tileId in TILE_REGISTRY &&
			typeof (s as Slot).size === 'string',
	);
	return clean.length > 0 ? clean : null;
}

function load(siteId: string): Slot[] {
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
	const [slots, setSlotsState] = useState<Slot[]>(() => load(siteId));

	useEffect(() => {
		setSlotsState(load(siteId));
	}, [siteId]);

	const setSlots = useCallback(
		(next: Slot[]) => {
			setSlotsState(next);
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
		try {
			localStorage.removeItem(KEY(siteId));
		} catch {
			// ignore
		}
	}, [siteId]);

	return { slots, setSlots, reset };
}
