// The elastic-grid engine behind the bento board. Instead of CSS auto-flow with span classes, the board
// places every tile explicitly (so it knows which column/row tracks each tile occupies) and drives the
// grid's `fr` tracks from state. Expanding a tile inflates the tracks it spans and collapses the rest —
// all on one plane, spring-interpolated — which is what replaces the old drill-down modal.

import { type RefObject, useEffect, useRef, useState } from 'react';
import type { TileDensity } from '../components/boxes/types.js';
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

/**
 * The per-row minimum while a tile is focused. Previously this was `0`, which is what let a focused
 * tile crush its neighbours: measured on the shipped default layout, focusing `countries` left the
 * three KPI tiles 34px tall, i.e. an empty bar with the numeral clipped out entirely, and it bought
 * the focused tile only 245px in return. Twelve tiles destroyed for very little.
 *
 * 64px is lower than ROW_FLOOR because a tile this short no longer draws its resting composition: it
 * drops to the `compact` density tier, which is a single line of label + value rather than a label
 * over a 2rem numeral over a badge. The arithmetic, against the compact chrome in BentoTile: 16px of
 * `p-2` plus 12px clearing the overlaid label leaves 36px, and a one-line row is ~28px. It was 56px
 * first, which left 8px of body and drew the compact tier into a box too short to show it — the
 * chrome was being counted as free. Below this there is no rendering left worth showing, so this is a
 * hard floor and the board scrolls internally rather than going under it.
 */
export const FOCUS_ROW_FLOOR = '64px';

/**
 * The height under which a tile drops to `compact`.
 *
 * This is ROW_FLOOR, and deliberately so rather than a second, independently chosen number: ROW_FLOOR is
 * already the measured height at which the DEFAULT composition fits (label, 2rem numeral, delta badge,
 * inside the tile's own padding). A tile at or above it can draw that composition, so anything above it
 * is not compact by definition. Picking a larger threshold by feel — 132px, first attempt — took the
 * default tier away from tiles that had room for it and left visible dead space.
 */
const COMPACT_MAX_HEIGHT = Number.parseInt(ROW_FLOOR, 10);

/**
 * The density tier for a measured tile box. `focused` wins outright: a focused tile is never compact,
 * because focusing it is the user asking for its fullest rendering.
 *
 * HEIGHT ONLY, deliberately. Width was in this decision at first, and it was the wrong axis: focusing a
 * tile shrinks the COLUMN tracks too, so a neighbouring ranked list came out 232px wide and 312px tall
 * and rendered a single compact line above 280px of dead space. A ranked list draws perfectly well in
 * 232px of width. Narrow-but-tall is a job for the container queries inside each box
 * (`@max-[15rem]/tile:hidden` and friends, on the `@container/tile` body), which drop individual
 * elements out of a row; it is not a reason to switch composition.
 *
 * IMPORTANT: a zero box is UNMEASURED, not tiny. Layout has not run yet (or, in jsdom, never runs), and
 * treating 0 as "smaller than the threshold" made every tile render its compact tier — which is wrong on
 * a real first paint, and is how this first showed up: four suite failures finding the same metric
 * rendered twice.
 */
export function densityFor(width: number, height: number, focused: boolean): TileDensity {
	if (focused) return 'expanded';
	if (width <= 0 || height <= 0) return 'default';
	return height <= COMPACT_MAX_HEIGHT ? 'compact' : 'default';
}

/** Observe a tile's own box and report which of its three renderings it should draw. Measured rather
 * than derived from the size token — see the note on TileDensity for why that distinction is the whole
 * point. Returns `default` until the first measurement so the first paint is never `compact`. */
export function useTileDensity(ref: RefObject<HTMLElement | null>, focused: boolean): TileDensity {
	const [box, setBox] = useState<{ w: number; h: number } | null>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = (): void => {
			const r = el.getBoundingClientRect();
			setBox((prev) =>
				prev && Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
					? prev
					: { w: r.width, h: r.height },
			);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	if (!box) return focused ? 'expanded' : 'default';
	return densityFor(box.w, box.h, focused);
}

/** The row gap the board renders between tiles (`gap-3`), needed to convert a pixel height into a row
 * count. Kept next to the arithmetic that uses it rather than inferred from the class. */
const ROW_GAP_PX = 12;

/**
 * The shortest row a tile can occupy and still draw its `compact` tier. Distinct from ROW_FLOOR, which
 * is what the RESTING (`default`) tier needs; a compact tile is one line, so it needs far less. Kept
 * equal to FOCUS_ROW_FLOOR: both answer the same question, "how short before there is nothing left".
 */
const FIT_MIN_ROW_PX = 64;

/** How many rows fit in `height` without any tile going under its compact minimum. This is what caps
 * the board in fit mode: the honest answer to "no scrolling" is fewer tiles, not smaller ones. */
export function maxFitRows(height: number): number {
	if (!Number.isFinite(height) || height <= 0) return Number.POSITIVE_INFINITY;
	return Math.max(1, Math.floor((height + ROW_GAP_PX) / (FIT_MIN_ROW_PX + ROW_GAP_PX)));
}

/** The container's measured height in px, or 0 before the first measurement. */
export function useBoardHeight(ref: RefObject<HTMLElement | null>): number {
	const [h, setH] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = (): void => setH(el.clientHeight);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return h;
}

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
 * once the mins exceed the viewport rather than shrinking tiles to nothing.
 *
 * `min` may be a single value for every track, or one value PER TRACK. The per-track form exists because
 * a single floor cannot express focus: once the floors sum past the container the `fr` weights distribute
 * nothing at all, so with one global floor the FOCUSED tile shrinks along with its neighbours instead of
 * growing. Giving the focused tracks their own larger minimum is what makes expansion survive a board
 * whose floors already overflow (the shipped default layout is 16 rows, so it always does). */
export function trackTemplate(fr: number[], min: string | readonly string[] = '0'): string {
	return fr
		.map((f, i) => `minmax(${Array.isArray(min) ? (min[i] ?? '0') : (min as string)}, ${f}fr)`)
		.join(' ');
}

/**
 * The height a focused tile is guaranteed, in px, before any `fr` distribution. Split across the rows it
 * spans and applied as those tracks' minimum.
 *
 * A focused tile has to clear its own `expanded` rendering or expanding it is a visible no-op: the three
 * KPI tiles on the shipped board are one row each, and at the resting 88px floor their expanded layout
 * (large value over a full area chart plus an Avg/Peak/Low strip) has nowhere to draw. 300px is that
 * layout's measured need plus the tile's own chrome.
 */
const FOCUS_TILE_MIN_PX = 300;

/** Per-row `minmax` minimums for a board in the given focus state. Non-focused rows drop to
 * FOCUS_ROW_FLOOR (their compact tier), which is what frees the height the focused tile takes. */
export function rowMinimums(rows: number, focus: Placement | null): string[] {
	if (!focus) return new Array(rows).fill(ROW_FLOOR);
	const per = Math.ceil(FOCUS_TILE_MIN_PX / Math.max(1, focus.rowSpan));
	return Array.from({ length: rows }, (_, i) =>
		i + 1 >= focus.rowStart && i + 1 < focus.rowStart + focus.rowSpan
			? `${Math.max(per, Number.parseInt(FOCUS_ROW_FLOOR, 10))}px`
			: FOCUS_ROW_FLOOR,
	);
}
