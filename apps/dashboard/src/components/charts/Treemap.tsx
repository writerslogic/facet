// Zoomable treemap over the URL-prefix tree. Rectangle AREA is subtree pageviews; clicking a child
// scales it up to fill the container and lays its own children out inside.
//
// The layout is squarified (Bruls, Huizing & van Wijk 2000): pack siblings into rows across the
// shorter side of the remaining rectangle, extending a row only while doing so keeps the worst
// aspect ratio in it from getting worse. Naive slice-and-dice is one loop shorter but produces
// slivers you cannot label or click, which is the whole reason this chart exists over a bar list.
//
// Interaction matches the sunburst on purpose: only the top level is openable, so anything the mouse
// can drill into, Tab reaches too, and `other`/`self` rectangles are inert because no page is behind
// them.

import { type ReactElement, useMemo, useRef, useState } from 'react';
import { type TreeItem, childrenTotal, describeItem } from '../../hooks/pathTree.js';
import { useHoverTarget } from '../../lib/chartInteraction.js';
import { formatNumber } from '../../lib/format.js';
import { useSize } from '../../lib/useSize.js';
import { ChartTooltip, TooltipRow } from './ChartTooltip.js';
import { HUES, lerp, sliceFill, sliceStroke, useLayoutTransition } from './hierarchy.js';

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A placed rectangle. `level` is 1 for the focus's own children, 2 for theirs, and so on. */
export interface TreemapTile extends Rect {
	key: string;
	item: TreeItem;
	level: number;
	hue: number;
	parent: string | null;
	opacity: number;
}

/** The worst (furthest from 1) aspect ratio in a row of areas laid along a side of length `side`. */
function worstRatio(areas: number[], sum: number, side: number): number {
	if (sum <= 0 || side <= 0) return Number.POSITIVE_INFINITY;
	let max = 0;
	for (const a of areas) {
		if (a <= 0) continue;
		const ratio = Math.max((side * side * a) / (sum * sum), (sum * sum) / (side * side * a));
		if (ratio > max) max = ratio;
	}
	return max === 0 ? Number.POSITIVE_INFINITY : max;
}

/**
 * Squarified treemap of `items` (already ordered largest-first) into `rect`. Every returned rectangle
 * has area proportional to its item's value and lies inside `rect`; siblings never overlap.
 */
export function squarify(items: TreeItem[], rect: Rect): { item: TreeItem; rect: Rect }[] {
	const out: { item: TreeItem; rect: Rect }[] = [];
	// A zero-value item has no area to receive; keeping it would divide by zero in the ratio test.
	const sized = items.filter((i) => i.value > 0);
	const total = sized.reduce((s, i) => s + i.value, 0);
	if (sized.length === 0 || total <= 0 || rect.w <= 0 || rect.h <= 0) return out;

	const areaOf = (i: TreeItem): number => (i.value * rect.w * rect.h) / total;
	let { x, y, w, h } = rect;
	let index = 0;

	while (index < sized.length) {
		const side = Math.min(w, h);
		if (side <= 0) break;
		// Grow the row while the worst ratio improves; the first item always joins.
		let count = 0;
		let sum = 0;
		let best = Number.POSITIVE_INFINITY;
		while (index + count < sized.length) {
			const candidate = sized.slice(index, index + count + 1).map(areaOf);
			const candidateSum = sum + areaOf(sized[index + count] as TreeItem);
			const ratio = worstRatio(candidate, candidateSum, side);
			if (count > 0 && ratio > best) break;
			best = ratio;
			sum = candidateSum;
			count++;
		}
		// Lay the row across the shorter side; its thickness is whatever its total area demands.
		const thickness = Math.min(sum / side, Math.max(w, h));
		let offset = 0;
		for (let i = 0; i < count; i++) {
			const item = sized[index + i] as TreeItem;
			const extent = (areaOf(item) / sum) * side;
			out.push(
				w <= h
					? { item, rect: { x: x + offset, y, w: extent, h: thickness } }
					: { item, rect: { x, y: y + offset, w: thickness, h: extent } },
			);
			offset += extent;
		}
		if (w <= h) {
			y += thickness;
			h -= thickness;
		} else {
			x += thickness;
			w -= thickness;
		}
		index += count;
	}
	return out;
}

/** Height of the caption strip a parent keeps for itself when its children are drawn inside it. */
const HEADER = 15;
/** Inset between a parent's frame and its children, so nesting reads as nesting. */
const PAD = 2;
/** A rectangle smaller than this cannot hold a caption strip AND a legible child, so it stays whole. */
const NEST_MIN_W = 54;
const NEST_MIN_H = 38;

/** Lay out `focus`'s descendants, nesting up to `levels` deep inside `rect`. */
export function treemapLayout(focus: TreeItem, rect: Rect, levels: number): TreemapTile[] {
	const out: TreemapTile[] = [];
	const place = (parent: TreeItem, area: Rect, level: number, hue: number | null): void => {
		if (level > levels) return;
		squarify(parent.children, area).forEach(({ item, rect: r }, i) => {
			const itemHue = hue ?? i % HUES.length;
			out.push({
				...r,
				key: item.key,
				item,
				level,
				hue: itemHue,
				parent: level === 1 ? null : parent.key,
				opacity: 1,
			});
			const roomToNest = r.w >= NEST_MIN_W && r.h >= NEST_MIN_H;
			if (item.children.length > 0 && roomToNest) {
				place(
					item,
					{
						x: r.x + PAD,
						y: r.y + HEADER,
						w: r.w - PAD * 2,
						h: r.h - HEADER - PAD,
					},
					level + 1,
					itemHue,
				);
			}
		});
	};
	place(focus, rect, 1, null);
	return out;
}

/** Tween two layouts. Same contract as the sunburst's: shared keys move, new ones grow out of their
 * parent's old rectangle, departing ones hold and fade. */
export function tweenTiles(from: TreemapTile[], to: TreemapTile[], t: number): TreemapTile[] {
	const prev = new Map(from.map((tile) => [tile.key, tile]));
	const next = new Set(to.map((tile) => tile.key));
	const out = to.map((tile) => {
		const base = tile.parent ? prev.get(tile.parent) : undefined;
		const start = prev.get(tile.key) ??
			base ?? {
				x: tile.x + tile.w / 2,
				y: tile.y + tile.h / 2,
				w: 0,
				h: 0,
			};
		return {
			...tile,
			x: lerp(start.x, tile.x, t),
			y: lerp(start.y, tile.y, t),
			w: lerp(start.w, tile.w, t),
			h: lerp(start.h, tile.h, t),
		};
	});
	for (const tile of from) if (!next.has(tile.key)) out.push({ ...tile, opacity: 1 - t });
	return out;
}

// A treemap label is left-anchored, so an over-optimistic width estimate bleeds it over the
// neighbouring rectangle rather than just crowding its own. Estimate wide, not tight.
const trim = (label: string, px: number): string | null => {
	const room = Math.floor((px - 10) / 6);
	if (room < 3) return null;
	return label.length <= room ? label : `${label.slice(0, room - 1)}…`;
};

export function Treemap({
	focus,
	levels,
	minCount,
	onDrill,
	onBack,
	canGoBack,
}: {
	focus: TreeItem;
	/** Nesting levels to draw. */
	levels: number;
	minCount: number;
	onDrill: (item: TreeItem) => void;
	onBack: () => void;
	canGoBack: boolean;
}): ReactElement {
	const boxRef = useRef<HTMLDivElement>(null);
	const size = useSize(boxRef);
	const w = size.width || 320;
	const h = size.height || 260;

	const target = useMemo(
		() => treemapLayout(focus, { x: 0, y: 0, w, h }, levels),
		[focus, w, h, levels],
	);
	const tiles = useLayoutTransition(focus.key, target, tweenTiles);
	const [active, setActive] = useState<string | null>(null);

	const { hover, handlers } = useHoverTarget<TreemapTile>(boxRef, (px, py) => {
		// Deepest match wins: the nested children are painted over their parent, so that is also what
		// the pointer is pointing at.
		let found: TreemapTile | null = null;
		for (const tile of tiles) {
			if (tile.opacity <= 0.5) continue;
			const inside =
				px >= tile.x && px < tile.x + tile.w && py >= tile.y && py < tile.y + tile.h;
			if (inside && (!found || tile.level >= found.level)) found = tile;
		}
		return found;
	});
	// Drilling does not move the pointer, so the rectangle that was under it may have just become the
	// whole view. Keep the tooltip only while its rectangle is still a rectangle.
	const live =
		hover && tiles.some((t) => t.key === hover.datum.key && t.opacity > 0.5) ? hover : null;
	const total = childrenTotal(focus) || focus.value || 1;

	return (
		<div ref={boxRef} className="relative h-full w-full" {...handlers}>
			<svg
				width={w}
				height={h}
				viewBox={`0 0 ${w} ${h}`}
				className="block h-full w-full"
				// See Sunburst: a chart that carries controls is a group, not an image, or its own
				// controls disappear from assistive tech. The numbers live in the sr-only table.
				// biome-ignore lint/a11y/useSemanticElements: the rule's suggested <fieldset> cannot hold SVG geometry; this is a labelled group of graphical controls
				role="group"
				aria-label={`Path tree treemap, showing inside ${focus.path}`}
			>
				<title>{`Path tree treemap, showing inside ${focus.path}`}</title>
				{tiles.map((tile) => {
					if (tile.w <= 1 || tile.h <= 1 || tile.opacity <= 0.02) return null;
					const on = live?.datum.key === tile.key || active === tile.key;
					const openable = tile.level === 1 && tile.item.drillable;
					const nested = tile.item.children.length > 0 && tile.h >= NEST_MIN_H;
					const label = trim(tile.item.label, tile.w);
					const focused = active === tile.key;
					return (
						<g
							key={tile.key}
							opacity={tile.opacity}
							role={openable ? 'button' : undefined}
							tabIndex={openable ? 0 : undefined}
							aria-label={
								openable
									? `Open ${tile.item.path}, ${formatNumber(tile.item.value)} pageviews`
									: undefined
							}
							className={openable ? 'cursor-pointer' : 'pointer-events-none'}
							onClick={openable ? () => onDrill(tile.item) : undefined}
							onFocus={openable ? () => setActive(tile.key) : undefined}
							onBlur={openable ? () => setActive(null) : undefined}
							onKeyDown={
								openable
									? (e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												onDrill(tile.item);
											}
										}
									: undefined
							}
						>
							<rect
								x={tile.x + 0.5}
								y={tile.y + 0.5}
								width={Math.max(0, tile.w - 1)}
								height={Math.max(0, tile.h - 1)}
								rx={3}
								fill={sliceFill(tile.hue, tile.level, tile.item.kind, on)}
								stroke={
									focused
										? 'var(--focus-ring)'
										: sliceStroke(tile.hue, tile.item.kind, on)
								}
								strokeWidth={focused ? 2.5 : 1}
							/>
							{label && tile.h >= 14 ? (
								<text
									x={tile.x + 5}
									y={tile.y + (nested ? 10 : 12)}
									className="pointer-events-none font-medium text-[10px]"
									fill="var(--ink)"
								>
									{label}
								</text>
							) : null}
							{label && !nested && tile.h >= 28 ? (
								<text
									x={tile.x + 5}
									y={tile.y + 24}
									className="pointer-events-none text-[10px] tabular-nums"
									fill="var(--muted)"
								>
									{formatNumber(tile.item.value)}
								</text>
							) : null}
						</g>
					);
				})}
			</svg>
			{canGoBack ? (
				<button
					type="button"
					data-chrome
					onClick={onBack}
					className="absolute top-1 right-1 rounded-lg border border-[color:rgb(var(--border))] bg-[color:var(--panel)] px-2 py-0.5 font-medium text-[10px] text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)]"
				>
					{`Back up from ${focus.path}`}
				</button>
			) : null}
			{live ? (
				<ChartTooltip x={live.x} y={live.y} containerWidth={w} containerHeight={h}>
					<p className="mb-1 break-all font-semibold">
						{describeItem(live.datum.item, minCount)}
					</p>
					<TooltipRow
						label="Pageviews"
						value={formatNumber(live.datum.item.value)}
						swatch={sliceFill(
							live.datum.hue,
							live.datum.level,
							live.datum.item.kind,
							true,
						)}
					/>
					{live.datum.level === 1 ? (
						<TooltipRow
							label="Share of view"
							value={`${Math.round((live.datum.item.value / total) * 100)}%`}
						/>
					) : null}
					{live.datum.item.drillable && live.datum.level === 1 ? (
						<TooltipRow label="Click" value="to open" />
					) : null}
				</ChartTooltip>
			) : null}
		</div>
	);
}
