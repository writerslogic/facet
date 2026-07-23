// The elastic-grid engine behind the bento board. Instead of CSS auto-flow with span classes, the board
// places every tile explicitly (so it knows which column/row tracks each tile occupies) and drives the
// grid's `fr` tracks from state. Expanding a tile inflates the tracks it spans and collapses the rest —
// all on one plane, spring-interpolated — which is what replaces the old drill-down modal.

import { type RefObject, useEffect, useRef, useState } from 'react';
import type { SizeKey, Slot } from './tiles.js';

export interface Placement {
	colStart: number; // 1-based grid line
	colSpan: number;
	rowStart: number; // 1-based grid line
	rowSpan: number;
}

type Span = readonly [cols: number, rows: number];

// Column/row spans per size at the two column counts the board uses. Derived from the SIZES class table:
// the 6-column spans match the `lg:` grid, the 2-column spans match the base (mobile) grid.
const SPAN_LG: Record<SizeKey, Span> = {
	kpi: [2, 1],
	sm: [1, 2],
	md: [2, 2],
	lg: [3, 2],
	short: [3, 1],
	tall: [3, 3],
	wide: [6, 2],
	xl: [4, 3],
};
const SPAN_SM: Record<SizeKey, Span> = {
	kpi: [1, 1],
	sm: [1, 1],
	md: [1, 1],
	lg: [2, 1],
	short: [2, 1],
	tall: [2, 1],
	wide: [2, 1],
	xl: [2, 2],
};

/** Rows the shipped 6-column layout packs into. At or below this the board fills the viewport with no
 * scroll (fr tracks divide the height); above it, rows fall back to a minimum height and the board scrolls. */
export const BASE_ROWS = 6;

/** Place slots into a `cols`-wide grid with greedy first-fit — the same sparse algorithm CSS grid uses for
 * auto-placement, so the packed result matches what the browser produced from the old span classes. Returns
 * one placement per slot (in slot order) plus the total row count. */
export function packSlots(
	slots: Slot[],
	cols: number,
): { placements: Placement[]; rowCount: number } {
	const spans = cols >= 6 ? SPAN_LG : SPAN_SM;
	const occ: boolean[][] = [];
	const ensureRow = (r: number): void => {
		while (occ.length <= r) occ.push(new Array(cols).fill(false));
	};
	const free = (r: number, c: number, cs: number, rs: number): boolean => {
		if (c + cs > cols) return false;
		for (let dr = 0; dr < rs; dr++) {
			ensureRow(r + dr);
			for (let dc = 0; dc < cs; dc++) if (occ[r + dr]?.[c + dc]) return false;
		}
		return true;
	};
	const fill = (r: number, c: number, cs: number, rs: number): void => {
		for (let dr = 0; dr < rs; dr++) {
			ensureRow(r + dr);
			for (let dc = 0; dc < cs; dc++) (occ[r + dr] as boolean[])[c + dc] = true;
		}
	};

	const placements = slots.map((slot): Placement => {
		const [wantCols, rs] = spans[slot.size];
		const cs = Math.min(wantCols, cols); // a wide tile on a narrow grid clamps to full width
		for (let r = 0; ; r++) {
			for (let c = 0; c + cs <= cols; c++) {
				if (free(r, c, cs, rs)) {
					fill(r, c, cs, rs);
					return {
						colStart: c + 1,
						colSpan: cs,
						rowStart: r + 1,
						rowSpan: rs,
					};
				}
			}
		}
	});
	return { placements, rowCount: Math.max(1, occ.length) };
}

/** The column count for a container width — mirrors the Tailwind `lg` breakpoint the board shipped with. */
export function useColumns(ref: RefObject<HTMLElement | null>): number {
	const [cols, setCols] = useState(6);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = (): void => setCols(el.clientWidth >= 1024 ? 6 : 2);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return cols;
}

const GROW = 2.2; // fr weight of a focused tile's tracks
const SHRINK = 0.5; // fr weight of every other track while a tile is focused

/** Target fr weights for a `count`-length axis when the tracks [start, start+span) are focused. With no
 * focus (`start` null) every track rests at 1fr. */
function axisTarget(count: number, start: number | null, span: number): number[] {
	if (start == null) return new Array(count).fill(1);
	return Array.from({ length: count }, (_, i) =>
		i + 1 >= start && i + 1 < start + span ? GROW : SHRINK,
	);
}

function reducedMotion(): boolean {
	return (
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

// easeOutBack: eases to the target with a small overshoot so the settle reads as a spring rather than a slide.
function springEase(p: number): number {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
}

const SPRING_MS = 440;

/** Spring-animate the column/row fr arrays toward the focused target. Display state is seeded from the
 * target so the first paint is already correct (tests and no-JS render see a valid grid synchronously);
 * only later focus changes animate. A change in track count (the layout itself changed) snaps rather than
 * tweening, since interpolating between different-length arrays is meaningless. */
export function useElasticTracks(
	cols: number,
	rows: number,
	focus: Placement | null,
): { colFr: number[]; rowFr: number[] } {
	const target = {
		cols: axisTarget(cols, focus ? focus.colStart : null, focus?.colSpan ?? 0),
		rows: axisTarget(rows, focus ? focus.rowStart : null, focus?.rowSpan ?? 0),
	};
	const [colFr, setColFr] = useState(target.cols);
	const [rowFr, setRowFr] = useState(target.rows);
	const disp = useRef({ cols: colFr, rows: rowFr });
	disp.current = { cols: colFr, rows: rowFr };
	const raf = useRef(0);
	const key = `${cols}:${rows}:${focus ? `${focus.colStart}/${focus.colSpan}-${focus.rowStart}/${focus.rowSpan}` : 'rest'}`;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` encodes every input the animation reads; the target arrays are recomputed from it each run
	useEffect(() => {
		if (
			disp.current.cols.length !== target.cols.length ||
			disp.current.rows.length !== target.rows.length ||
			reducedMotion()
		) {
			setColFr(target.cols);
			setRowFr(target.rows);
			return;
		}
		const fromCols = disp.current.cols.slice();
		const fromRows = disp.current.rows.slice();
		const start = performance.now();
		const lerp = (from: number[], to: number[], e: number): number[] =>
			from.map((v, i) => Math.max(0.05, v + ((to[i] ?? v) - v) * e));
		const tick = (t: number): void => {
			const p = Math.min(1, (t - start) / SPRING_MS);
			const e = springEase(p);
			setColFr(lerp(fromCols, target.cols, e));
			setRowFr(lerp(fromRows, target.rows, e));
			if (p < 1) raf.current = requestAnimationFrame(tick);
		};
		raf.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf.current);
	}, [key]);

	return { colFr, rowFr };
}

/** Turn an fr array into a grid-template string. `minmax(0, Nfr)` lets a focused track collapse its
 * neighbours all the way, so the elastic effect is dramatic and the grid still fills its container exactly. */
export function trackTemplate(fr: number[]): string {
	return fr.map((f) => `minmax(0, ${f}fr)`).join(' ');
}
