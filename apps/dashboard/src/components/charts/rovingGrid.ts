// Roving tabindex for a chart whose marks form a grid (the calendar's 7 × N weeks, the clock's
// 7 × 24 cells).
//
// WHY not simply `tabIndex={0}` on every mark: the calendar can hold 90 cells and the clock always
// holds 168. Making each one its own tab stop puts up to 168 stops between a keyboard user and the
// next tile — which is why `WorldMap` gave up on keyboard access for its 175 country paths
// altogether. Roving is the standard fix and gives up nothing: the grid is ONE tab stop, arrow keys
// move within it, and every mark is still individually reachable and activatable.
//
// The chart owns the geometry, so the caller supplies the index deltas for a horizontal and a
// vertical step (the calendar is column-major, the clock row-major) rather than this module guessing.

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

/** Either kind of mark a chart draws: an SVG group, or an HTML button overlaid on the drawing. */
export type FocusableMark = SVGGElement | HTMLElement;

export interface RovingGrid {
	/** Index of the mark that currently holds the grid's single tab stop. */
	active: number;
	setActive: (index: number) => void;
	/** Ref callback for mark `index`, so an arrow key can move DOM focus, not just state. */
	register: (index: number) => (el: FocusableMark | null) => void;
	/** `0` for the active mark, `-1` for every other — the roving contract. */
	tabIndexFor: (index: number) => 0 | -1;
	/** Arrow/Home/End handler. Returns nothing; the caller still owns Enter/Space activation. */
	onKeyDown: (event: KeyboardEvent) => void;
}

export function useRovingGrid(
	count: number,
	steps: { horizontal: number; vertical: number },
): RovingGrid {
	const [active, setActive] = useState(0);
	const nodes = useRef(new Map<number, FocusableMark>());
	// Only steal focus when a key MOVED the cursor. Without this, any re-render that lands while the
	// tile is elsewhere on the page would yank focus into the chart.
	const pendingFocus = useRef(false);

	// A new dataset (range change, filter, timezone flip) renumbers the marks; an index kept from the
	// previous grid would point at an unrelated cell, or past the end.
	useEffect(() => {
		setActive((i) => (i < count ? i : 0));
	}, [count]);

	useEffect(() => {
		if (!pendingFocus.current) return;
		pendingFocus.current = false;
		nodes.current.get(active)?.focus();
	}, [active]);

	const register = useCallback(
		(index: number) => (el: FocusableMark | null) => {
			if (el) nodes.current.set(index, el);
			else nodes.current.delete(index);
		},
		[],
	);

	const { horizontal, vertical } = steps;
	const onKeyDown = useCallback(
		(event: KeyboardEvent) => {
			const delta =
				event.key === 'ArrowRight'
					? horizontal
					: event.key === 'ArrowLeft'
						? -horizontal
						: event.key === 'ArrowDown'
							? vertical
							: event.key === 'ArrowUp'
								? -vertical
								: 0;
			let next: number | null = delta === 0 ? null : active + delta;
			if (event.key === 'Home') next = 0;
			if (event.key === 'End') next = count - 1;
			if (next == null) return;
			// Clamp rather than wrap: wrapping off the end of a week into the next one reads as a jump
			// backwards in time, and the grid has no cyclic meaning along either axis.
			const clamped = Math.max(0, Math.min(count - 1, next));
			event.preventDefault();
			pendingFocus.current = true;
			setActive(clamped);
		},
		[active, count, horizontal, vertical],
	);

	const tabIndexFor = useCallback(
		(index: number): 0 | -1 => (index === active ? 0 : -1),
		[active],
	);

	return { active, setActive, register, tabIndexFor, onKeyDown };
}
