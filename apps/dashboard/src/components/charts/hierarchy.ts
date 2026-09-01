// What the sunburst and the treemap have in common: how a slice is coloured, and how a layout gets
// from where it is to where a drill just put it.
//
// WHY THE COLOUR RULE IS A FUNCTION AND NOT A CLASS NAME: both charts paint labels ON their slices,
// and there are five palettes × two modes. A slice fill is therefore always a TINT of a categorical
// hue mixed into `--panel` — never the raw hue. The panel is the surface `--ink` was designed to sit
// on at 4.5:1, and mixing at most `MAX_TINT` of any hue into it moves it too little to lose that
// (asserted for every palette/mode in test/hierarchyCharts.test.tsx). The hue still reads: it is the
// stroke, at full strength, and the tint step encodes depth.

import { useRef, useState } from 'react';
import type { TreeKind } from '../../hooks/pathTree.js';
import { useSpring } from '../../lib/chartInteraction.js';

/** The categorical hues. One per sibling at the first visible level; descendants inherit theirs. */
export const HUES = [
	'var(--c1)',
	'var(--c2)',
	'var(--c3)',
	'var(--c4)',
	'var(--c5)',
	'var(--c6)',
] as const;

/** Percent of the hue mixed into `--panel`, by visible level. Deeper recedes, which is also what
 * makes the ring/nesting structure legible without a legend. */
const TINT = [30, 24, 18, 13] as const;

/** Extra tint under the pointer/focus. TINT[0] + this is the strongest fill this chart can paint. */
const HOVER_BOOST = 6;

/** The ceiling the contrast test pins. It is NOT a guess: the palettes carry hues as bright as bio's
 * `--c1` (#66fcf1), and mixing that over the dark panel at 46% drops `--ink` on top of it to 4.08:1.
 * 36% is the strongest mix under which every hue in all five palettes, both modes, still clears
 * 4.5:1 with margin (worst case 5.4:1). Raise it and the test will tell you which hue broke. */
export const MAX_TINT = TINT[0] + HOVER_BOOST;

const tintAt = (level: number): number => TINT[Math.min(Math.max(level, 1), TINT.length) - 1] ?? 13;

/** The fill for a slice: a tint of its hue over the panel, so `--ink` stays legible on top of it. */
export function sliceFill(hue: number, level: number, kind: TreeKind, active: boolean): string {
	const strength = tintAt(level) + (active ? HOVER_BOOST : 0);
	// `other` is an aggregate, not a page: it is deliberately the only slice with no hue at all, so it
	// never reads as one more sibling you could open.
	if (kind === 'other') {
		return `color-mix(in srgb, var(--muted) ${Math.round(strength * 0.7)}%, var(--panel))`;
	}
	// `self` is the same URL as its parent, so it keeps the parent's hue at half strength — related,
	// visibly not a new branch.
	const pct = kind === 'self' ? Math.round(strength * 0.5) : strength;
	return `color-mix(in srgb, ${HUES[hue % HUES.length]} ${pct}%, var(--panel))`;
}

/** The outline for a slice: the hue at full saturation. This is where the colour actually reads. */
export function sliceStroke(hue: number, kind: TreeKind, active: boolean): string {
	if (kind === 'other')
		return `color-mix(in srgb, var(--muted) ${active ? 85 : 55}%, transparent)`;
	return `color-mix(in srgb, ${HUES[hue % HUES.length]} ${active ? 95 : 60}%, transparent)`;
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Fit `label` into `px` at an assumed `charPx` per character, ellipsised, or null when even three
 * characters will not fit. Estimate wide rather than tight: a label that overflows its own box bleeds
 * over the neighbouring slice. */
export const trim = (label: string, px: number, charPx: number): string | null => {
	const room = Math.floor(px / charPx);
	if (room < 3) return null;
	return label.length <= room ? label : `${label.slice(0, room - 1)}…`;
};

/**
 * Drive a layout from wherever it currently is to wherever `key` just moved it.
 *
 * The spring runs on ONE scalar per chart rather than one per shape, and `interpolate` spreads that
 * scalar over the whole layout. Retargeting is the point: drill twice quickly and the second
 * transition starts from what is on screen (`from` is the last INTERPOLATED layout, not the previous
 * settled one) and rebases the spring's progress, so there is no snap back to a frame nobody saw.
 * Reduced motion needs no branch here — `useSpring` snaps, `t` is 1 on the first frame, done.
 */
export function useLayoutTransition<L>(
	key: string,
	layout: L,
	interpolate: (from: L, to: L, t: number) => L,
): L {
	// Monotonic: each drill adds one, and the spring chases it. The absolute value is meaningless;
	// only the distance from `base` to the current target is.
	const [target, setTarget] = useState(0);
	const value = useSpring(target);
	const state = useRef({ key, base: 0, display: layout });

	if (state.current.key !== key) {
		// Adjust state during render (React's supported pattern) so the new structure paints in this
		// commit and only its geometry animates — a hidden tab or a test that never runs a frame
		// still shows the correct chart, just without the motion.
		state.current = { key, base: value, display: state.current.display };
		setTarget(target + 1);
	}

	const span = target - state.current.base;
	const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (value - state.current.base) / span));
	const display = t >= 1 ? layout : interpolate(state.current.display, layout, t);
	state.current.display = display;
	return display;
}
