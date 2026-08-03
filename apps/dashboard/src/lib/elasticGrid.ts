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
	wide: [6, 3],
	xl: [4, 3],
};
const SPAN_SM: Record<SizeKey, Span> = {
	kpi: [1, 1],
	sm: [1, 1],
	md: [1, 1],
	lg: [2, 1],
	short: [2, 1],
	tall: [2, 2],
	wide: [2, 2],
	xl: [2, 2],
};

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
	const rowCount = Math.max(1, occ.length);
	fillGaps(placements, cols, rowCount);
	return { placements, rowCount };
}

/** Grow placed tiles to absorb empty cells so the board never shows a dead gap (e.g. after a tile is
 * removed, or when the last row doesn't tessellate). Prefers extending the tile ABOVE an empty cell
 * downward, else the tile to its LEFT rightward — only ever into cells that are empty, keeping every tile
 * rectangular. Mutates `placements` in place; the persisted slot sizes are untouched, so this is purely a
 * render-time compaction that re-derives on every pack. Fully-packed layouts (the shipped default) are
 * left exactly as-is. */
function fillGaps(placements: Placement[], cols: number, rowCount: number): void {
	const ownerGrid = (): number[][] => {
		const g: number[][] = Array.from({ length: rowCount }, () => new Array(cols).fill(-1));
		placements.forEach((p, idx) => {
			for (let r = p.rowStart - 1; r < p.rowStart - 1 + p.rowSpan; r++)
				for (let c = p.colStart - 1; c < p.colStart - 1 + p.colSpan; c++)
					if (g[r]) (g[r] as number[])[c] = idx;
		});
		return g;
	};
	const rowClear = (g: number[][], r: number, c0: number, cs: number): boolean => {
		for (let c = c0; c < c0 + cs; c++) if (g[r]?.[c] !== -1) return false;
		return true;
	};
	const colClear = (g: number[][], c: number, r0: number, rs: number): boolean => {
		for (let r = r0; r < r0 + rs; r++) if (g[r]?.[c] !== -1) return false;
		return true;
	};
	for (let guard = 0; guard < cols * rowCount; guard++) {
		const g = ownerGrid();
		let changed = false;
		for (let r = 0; r < rowCount && !changed; r++) {
			for (let c = 0; c < cols && !changed; c++) {
				if (g[r]?.[c] !== -1) continue;
				const above = r > 0 ? (g[r - 1]?.[c] ?? -1) : -1;
				if (above !== -1) {
					const p = placements[above] as Placement;
					if (
						p.rowStart - 1 + p.rowSpan === r &&
						rowClear(g, r, p.colStart - 1, p.colSpan)
					) {
						p.rowSpan++;
						changed = true;
						break;
					}
				}
				const left = c > 0 ? (g[r]?.[c - 1] ?? -1) : -1;
				if (left !== -1) {
					const p = placements[left] as Placement;
					if (
						p.colStart - 1 + p.colSpan === c &&
						colClear(g, c, p.rowStart - 1, p.rowSpan)
					) {
						p.colSpan++;
						changed = true;
						break;
					}
				}
			}
		}
		if (!changed) break;
	}
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

/**
 * The resting per-row minimum height. This is a GENUINE minimum, not a divide-to-fit.
 *
 * It used to be `viewportHeight / rowCount`, which guaranteed the board never scrolled — and which
 * silently became the board's biggest rendering defect as tiles were added. At fourteen rows the floor
 * collapsed to 44px, so a one-row KPI tile had 12px of content box for a 34px readout and every chart
 * lost roughly half the height it was drawn against. A board that fits by clipping does not fit.
 *
 * Rows are `minmax(floor, 1fr)` inside a flex-sized grid, so while the floors add up to less than the
 * available height the `1fr` still distributes it exactly as before — nothing changes in the case the
 * old behaviour was protecting. Past that point the grid scrolls INTERNALLY (the page still never
 * scrolls), which is the honest outcome: five legible rows you scroll beat fourteen you cannot read.
 *
 * 88px is the smallest row in which the shortest tile (`kpi`, one row) fits its label, its 2rem
 * numeral and its delta badge inside the tile's own 16px padding — measured, with ~6px of slack for
 * a longer badge. It is the tightest slot on the board, so it is the one that sets the floor.
 */
export const ROW_FLOOR = '88px';

/** True when the container is too narrow for the elastic grid to stay legible — below this the board
 * switches to a full-size box carousel. */
export function useNarrow(ref: RefObject<HTMLElement | null>, threshold = 680): boolean {
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = (): void => setNarrow(el.clientWidth > 0 && el.clientWidth < threshold);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref, threshold]);
	return narrow;
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

/** Turn an fr array into a grid-template string. Each track is `minmax(min, Nfr)`: with `min` at 0 a
 * focused track can collapse its neighbours all the way (dramatic elastic focus); with a real `min` (e.g.
 * a row floor at rest) every tile keeps enough size to show its content, and the board scrolls internally
 * once the mins exceed the viewport rather than shrinking tiles to nothing. */
export function trackTemplate(fr: number[], min = '0'): string {
	return fr.map((f) => `minmax(${min}, ${f}fr)`).join(' ');
}
