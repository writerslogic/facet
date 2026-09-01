// Multi-level ring chart over the URL-prefix tree. The focused node is the centre; each ring out is
// one level deeper, and a slice's ANGLE is its share of its parent's subtree pageviews.
//
// TWO DELIBERATE LIMITS, both about keyboard parity:
//   * only the FIRST ring is interactive. A depth-3 view can hold well over a thousand slices, and
//     making every one of them a tab stop would be a worse accessibility outcome than a chart you
//     drill one level at a time. Whatever the mouse can open, Tab can reach — no exceptions.
//   * `other` and `self` slices are never openable by either. There is no page behind them.
// The outer rings stay as context and still answer a hover; the sr-only table has every number.

import { type ReactElement, useMemo, useRef, useState } from 'react';
import { type TreeItem, childrenTotal, describeItem } from '../../hooks/pathTree.js';
import { useHoverTarget, useSpring } from '../../lib/chartInteraction.js';
import { formatNumber } from '../../lib/format.js';
import { useSize } from '../../lib/useSize.js';
import { ChartKey } from './ChartChrome.js';
import { ChartTooltip, TooltipRow } from './ChartTooltip.js';
import { HUES, lerp, sliceFill, sliceStroke, trim, useLayoutTransition } from './hierarchy.js';

/** One laid-out slice. Angles are turns (0..1) clockwise from 12 o'clock, so nothing here is radians
 * and nothing here is pixels — the render owns both conversions. */
export interface SunburstArc {
	key: string;
	item: TreeItem;
	/** 1 = the ring of the focus's direct children. Fractional mid-transition. */
	ring: number;
	x0: number;
	x1: number;
	/** Index into the categorical palette, inherited from the ring-1 ancestor. */
	hue: number;
	/** Key of the arc this one sits inside, so a newly revealed arc knows where to grow from. */
	parent: string | null;
	/** 1, except for an arc on its way out of the chart. */
	opacity: number;
}

/**
 * Partition `focus`'s descendants into rings. Each level divides its parent's angular span in
 * proportion to `value`, so within any ring the slices of one parent exactly fill it and area is
 * comparable across the whole chart. `rings` caps how many levels are drawn.
 */
export function partitionArcs(focus: TreeItem, rings: number): SunburstArc[] {
	const out: SunburstArc[] = [];
	const walk = (
		item: TreeItem,
		x0: number,
		x1: number,
		ring: number,
		hue: number | null,
	): void => {
		if (ring > rings) return;
		const span = x1 - x0;
		const total = childrenTotal(item);
		if (span <= 0 || total <= 0) return;
		let x = x0;
		item.children.forEach((child, i) => {
			const w = (span * child.value) / total;
			const childHue = hue ?? i % HUES.length;
			out.push({
				key: child.key,
				item: child,
				ring,
				x0: x,
				x1: x + w,
				hue: childHue,
				parent: ring === 1 ? null : item.key,
				opacity: 1,
			});
			walk(child, x, x + w, ring + 1, childHue);
			x += w;
		});
	};
	walk(focus, 0, 1, 1, null);
	return out;
}

/** Interpolate one arc set toward another. An arc in both tweens; an arc only in `to` grows out of
 * its parent's old position (or blooms from the centre if that parent was off-screen too); an arc
 * only in `from` holds still and fades, so drilling does not pop the siblings out of existence. */
export function tweenArcs(from: SunburstArc[], to: SunburstArc[], t: number): SunburstArc[] {
	const prev = new Map(from.map((a) => [a.key, a]));
	const next = new Set(to.map((a) => a.key));
	const out = to.map((a) => {
		const base = a.parent ? prev.get(a.parent) : undefined;
		const start =
			prev.get(a.key) ??
			(base
				? { ring: base.ring + 1, x0: base.x0, x1: base.x1 }
				: { ring: 0, x0: (a.x0 + a.x1) / 2, x1: (a.x0 + a.x1) / 2 });
		return {
			...a,
			ring: lerp(start.ring, a.ring, t),
			x0: lerp(start.x0, a.x0, t),
			x1: lerp(start.x1, a.x1, t),
		};
	});
	for (const a of from) if (!next.has(a.key)) out.push({ ...a, opacity: 1 - t });
	return out;
}

/** Radius of the centre disc as a fraction of the chart radius. */
const CORE = 0.3;
/** Below this angular width a slice is under a pixel of arc at any tile size — drawing it would cost
 * a DOM node per invisible sliver on a wide tree. The sr-only table still carries it. */
const MIN_TURN = 0.0015;
/** How far a hovered/focused slice pushes past its ring, in px. */
const LIFT = 4;
/** Thinner than this and a ring holds no label and is awkward to aim at, so a ring is dropped instead. */
const MIN_RING_W = 18;
/** Centre radii below which the readout would spill over the first ring, so it is simply not drawn. */
const CORE_FOR_LABEL = 16;
const CORE_FOR_VALUE = 26;

const TAU = Math.PI * 2;

const point = (cx: number, cy: number, r: number, turn: number): [number, number] => [
	cx + r * Math.sin(turn * TAU),
	cy - r * Math.cos(turn * TAU),
];

/** Annular-sector path. Clamped just short of a full turn because an SVG elliptical arc cannot
 * express 360° in one command — the residue is ~0.04°, which is sub-pixel. */
export function arcPath(
	cx: number,
	cy: number,
	r0: number,
	r1: number,
	x0: number,
	x1: number,
): string {
	const turn = Math.min(x1 - x0, 0.9999);
	const end = x0 + turn;
	const large = turn > 0.5 ? 1 : 0;
	const [ax, ay] = point(cx, cy, r1, x0);
	const [bx, by] = point(cx, cy, r1, end);
	const [dx, dy] = point(cx, cy, r0, end);
	const [ex, ey] = point(cx, cy, r0, x0);
	return [
		`M${ax.toFixed(2)},${ay.toFixed(2)}`,
		`A${r1.toFixed(2)},${r1.toFixed(2)} 0 ${large} 1 ${bx.toFixed(2)},${by.toFixed(2)}`,
		`L${dx.toFixed(2)},${dy.toFixed(2)}`,
		`A${r0.toFixed(2)},${r0.toFixed(2)} 0 ${large} 0 ${ex.toFixed(2)},${ey.toFixed(2)}`,
		'Z',
	].join(' ');
}

/** Average advance width per character, by the two type sizes this chart sets: 10px regular on a
 * slice, 11px semibold in the centre. One shared 5.6 was used for both, which over-estimated the
 * centre by ~15% — so the readout spilled out of the disc and across the first ring, which is exactly
 * what a rendering fault looks like. */
const CHAR_PX = { slice: 5.6, core: 6.5 } as const;

/**
 * Width to hand the key beside the dial, or 0 for "draw the dial alone".
 *
 * A sunburst is a circle: it letterboxes to the shorter side and leaves the rest of a wide tile
 * empty — at the shipped `tall` size that was over half the tile drawing nothing. The leftover width
 * is spent on the numbers the rings structurally cannot print. Only when the leftover is genuinely
 * spare (the box is half again as wide as it is tall AND there is real room), so the dial never
 * shrinks to make space for its own key.
 */
export function keyWidth(w: number, h: number): number {
	const spare = w - h;
	if (w < h * 1.5 || spare < 130) return 0;
	return Math.min(190, Math.max(110, spare - 12));
}

export function Sunburst({
	focus,
	rings,
	minCount,
	onDrill,
	onBack,
	canGoBack,
}: {
	focus: TreeItem;
	/** Levels of descendants to draw beyond the centre. */
	rings: number;
	/** The anonymity floor, for the wording on an `other` slice. */
	minCount: number;
	onDrill: (item: TreeItem) => void;
	onBack: () => void;
	canGoBack: boolean;
}): ReactElement {
	const boxRef = useRef<HTMLDivElement>(null);
	const size = useSize(boxRef);
	// Fall back to a sane box before the first measurement (and anywhere ResizeObserver never fires),
	// so the very first paint is already a chart rather than an empty frame.
	const w = size.width || 320;
	const h = size.height || 260;
	const legendW = keyWidth(w, h);
	// The dial's box is kept near-square and the [dial | key] pair is CENTRED as a group, rather than
	// the dial floating in half a very wide tile with the key pinned to the far edge. A circle cannot
	// use width beyond its own diameter, so anything past that is not "space for the chart", it is a
	// gap in the middle of the composition. `radius` is unchanged either way — height is what binds it.
	const chartW = legendW > 0 ? Math.min(w - legendW, Math.max(h * 1.15, 180)) : w;
	const originX = Math.max(0, (w - chartW - legendW) / 2);
	// One coordinate system for drawing AND hit-testing: the svg spans the whole measured box, so the
	// pointer maths needs no separate notion of where the dial was placed inside it.
	const cx = originX + chartW / 2;
	const cy = h / 2;
	const radius = Math.max(24, Math.min(chartW, h) / 2 - 6);
	const core = radius * CORE;
	// Drop rings rather than shave them. On a small tile three rings are each ~13px, which is too thin
	// to label and too thin to aim at; two thick rings say less but say it legibly.
	const shown = Math.max(1, Math.min(rings, Math.floor((radius - core) / MIN_RING_W)));
	const ringW = (radius - core) / shown;

	const target = useMemo(() => partitionArcs(focus, shown), [focus, shown]);
	const arcs = useLayoutTransition(focus.key, target, tweenArcs);

	// Keyboard focus and pointer hover over the key are kept apart: only the former may paint a focus
	// ring, or hovering the key would fake a focus indicator on a slice nothing is focused on.
	const [active, setActive] = useState<string | null>(null);
	const [keyHover, setKeyHover] = useState<string | null>(null);

	const radii = (ring: number): [number, number] => [
		core + (ring - 1) * ringW + 0.75,
		core + ring * ringW - 0.75,
	];

	const { hover, handlers } = useHoverTarget<SunburstArc>(boxRef, (px, py) => {
		const dx = px - cx;
		const dy = py - cy;
		const r = Math.hypot(dx, dy);
		if (r < core || r > radius) return null;
		const ring = Math.floor((r - core) / ringW) + 1;
		// atan2 measured from 12 o'clock, clockwise, normalized into 0..1 to match the layout.
		const turn = (Math.atan2(dx, -dy) / TAU + 1) % 1;
		return (
			arcs.find(
				(a) =>
					Math.round(a.ring) === ring && turn >= a.x0 && turn < a.x1 && a.opacity > 0.5,
			) ?? null
		);
	});
	// Drilling does not move the pointer, so the slice that was under it a moment ago may have just
	// become the centre. Keep the tooltip only while its slice is still a slice.
	const live =
		hover && arcs.some((a) => a.key === hover.datum.key && a.opacity > 0.5) ? hover : null;
	const activeArc =
		arcs.find((a) => a.key === active) ??
		live?.datum ??
		arcs.find((a) => a.key === keyHover) ??
		null;
	const highlighted = activeArc?.key ?? null;
	const total = childrenTotal(focus) || focus.value || 1;
	// One spring for the lift, applied to whichever slice is currently highlighted — a spring per slice
	// would be a hook per slice, which React does not allow and the eye cannot tell apart anyway.
	const lift = useSpring(highlighted ? LIFT : 0);

	const keyItems = useMemo(
		() =>
			legendW === 0
				? []
				: arcs
						.filter((a) => Math.round(a.ring) === 1 && a.opacity > 0.5)
						.sort((a, b) => b.item.value - a.item.value)
						// One row is 14px; leave the last row's worth of slack so the list never
						// half-clips a row (which reads as a broken list, not a truncated one).
						.slice(0, Math.max(1, Math.floor((h - 6) / 14)))
						.map((a) => ({
							key: a.key,
							label: a.item.label,
							value: formatNumber(a.item.value),
							detail: `${Math.round((a.item.value / total) * 100)}%`,
							swatch: sliceStroke(a.hue, a.item.kind, true),
						})),
		[arcs, legendW, h, total],
	);

	return (
		<div ref={boxRef} className="relative h-full w-full" {...handlers}>
			<svg
				width={w}
				height={h}
				viewBox={`0 0 ${w} ${h}`}
				className="block h-full w-full overflow-visible"
				// Same call the Sankey makes: `role="img"` turns the whole subtree presentational, so a
				// chart carrying its own controls would hide them from assistive tech
				// (axe: nested-interactive). An interactive chart is a group of controls; the numbers
				// are carried by the sr-only table the caller renders beside it.
				// biome-ignore lint/a11y/useSemanticElements: the rule's suggested <fieldset> cannot hold SVG geometry; this is a labelled group of graphical controls
				role="group"
				aria-label={`Path tree sunburst, centred on ${focus.path}`}
			>
				<title>{`Path tree sunburst, centred on ${focus.path}`}</title>
				{arcs.map((arc) => {
					if (arc.x1 - arc.x0 < MIN_TURN || arc.ring < 0.5 || arc.opacity <= 0.02) {
						return null;
					}
					const on = highlighted === arc.key;
					const [r0, r1] = radii(arc.ring);
					const outer = r1 + (on ? lift : 0);
					if (outer <= r0) return null;
					const level = Math.max(1, Math.round(arc.ring));
					// Ring 1 only: see the header. Deeper rings are context, so they take no pointer
					// events either and hover falls through to the geometric resolver above.
					const openable = Math.round(arc.ring) === 1 && arc.item.drillable;
					const mid = (arc.x0 + arc.x1) / 2;
					const arcPx = (arc.x1 - arc.x0) * TAU * ((r0 + outer) / 2);
					// The key already names every ring-1 slice and gives its number, so painting the
					// names onto the rings as well only adds rotated three-character stubs across the
					// geometry. Labels are for the tile that has no room for a key.
					const label =
						legendW === 0 && arc.ring <= 2.5 && outer - r0 >= 13
							? trim(arc.item.label, arcPx - 8, CHAR_PX.slice)
							: null;
					const flip = mid > 0.5;
					return (
						<g
							key={arc.key}
							opacity={arc.opacity}
							role={openable ? 'button' : undefined}
							tabIndex={openable ? 0 : undefined}
							aria-label={
								openable
									? `Open ${arc.item.path}, ${formatNumber(arc.item.value)} pageviews`
									: undefined
							}
							className={openable ? 'cursor-pointer' : 'pointer-events-none'}
							onClick={openable ? () => onDrill(arc.item) : undefined}
							onFocus={openable ? () => setActive(arc.key) : undefined}
							onBlur={openable ? () => setActive(null) : undefined}
							onKeyDown={
								openable
									? (e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												onDrill(arc.item);
											}
										}
									: undefined
							}
						>
							<path
								d={arcPath(cx, cy, r0, outer, arc.x0, arc.x1)}
								fill={sliceFill(arc.hue, level, arc.item.kind, on)}
								stroke={
									on && active === arc.key
										? 'var(--focus-ring)'
										: sliceStroke(arc.hue, arc.item.kind, on)
								}
								strokeWidth={on && active === arc.key ? 2.5 : 1}
							/>
							{label ? (
								<text
									x={0}
									y={0}
									textAnchor="middle"
									dominantBaseline="central"
									className="pointer-events-none font-medium text-[10px]"
									fill="var(--ink)"
									transform={`rotate(${mid * 360} ${cx} ${cy}) translate(${cx} ${cy - (r0 + outer) / 2}) rotate(${flip ? 90 : -90})`}
								>
									{label}
								</text>
							) : null}
						</g>
					);
				})}
				{/* The centre is both the readout and the way back up. */}
				<g
					role={canGoBack ? 'button' : undefined}
					tabIndex={canGoBack ? 0 : undefined}
					aria-label={canGoBack ? `Back up from ${focus.path}` : undefined}
					className={canGoBack ? 'cursor-pointer' : undefined}
					onClick={canGoBack ? onBack : undefined}
					onKeyDown={
						canGoBack
							? (e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										onBack();
									}
								}
							: undefined
					}
				>
					<circle
						cx={cx}
						cy={cy}
						r={core - 1}
						fill="var(--panel)"
						stroke="rgb(var(--border-strong))"
					/>
					{/* The readout is suppressed rather than clipped on a small tile: text spilling out
					    over the first ring reads as a rendering fault, and the breadcrumb above the
					    chart already names where you are. */}
					{core >= CORE_FOR_LABEL ? (
						<text
							x={cx}
							y={core >= CORE_FOR_VALUE ? cy - 6 : cy}
							textAnchor="middle"
							dominantBaseline={core >= CORE_FOR_VALUE ? undefined : 'central'}
							className="font-semibold text-[11px]"
							fill="var(--ink)"
						>
							{trim(focus.label, core * 1.7, CHAR_PX.core) ?? '/'}
						</text>
					) : null}
					{core >= CORE_FOR_VALUE ? (
						<text
							x={cx}
							y={cy + 8}
							textAnchor="middle"
							className="text-[10px] tabular-nums"
							fill="var(--muted)"
						>
							{formatNumber(focus.value)}
						</text>
					) : null}
				</g>
			</svg>
			{legendW > 0 ? (
				<ChartKey
					items={keyItems}
					highlighted={highlighted}
					onHover={setKeyHover}
					className="-translate-y-1/2 absolute top-1/2 pl-2"
					style={{ left: originX + chartW, width: legendW }}
				/>
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
							Math.max(1, Math.round(live.datum.ring)),
							live.datum.item.kind,
							true,
						)}
					/>
					{Math.round(live.datum.ring) === 1 ? (
						<TooltipRow
							label="Share of centre"
							value={`${Math.round((live.datum.item.value / total) * 100)}%`}
						/>
					) : null}
					{live.datum.item.drillable && Math.round(live.datum.ring) === 1 ? (
						<TooltipRow label="Click" value="to open" />
					) : null}
				</ChartTooltip>
			) : null}
		</div>
	);
}
