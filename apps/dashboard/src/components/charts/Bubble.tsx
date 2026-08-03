// A packed bubble field for a breakdown: area = volume, position = two behavioural RATES, colour =
// identity.
//
// WHY these encodings. A ranked bar list already answers "which channel is biggest"; a bubble chart
// that only restates the ranking in circles is decoration. The two things the list structurally
// cannot show are both rates, and both are computable exactly from additive counts:
//
//   x — events per pageview: how hard the segment interacts once it arrives.
//   y — momentum: (second-half − first-half) share of the segment's own pageviews over the range,
//       i.e. whether it is growing or shrinking WITHIN the window, independent of how big it is.
//
// Volume, engagement and trend are three genuinely independent quantities, so the field reads as a
// quadrant: big-and-rising-and-engaged is top-right, and a large bubble sinking bottom-left is the
// one the ranked list would have flattered. Colour is deliberately NOT a fourth number — it is
// identity, tying a bubble to its label, its tooltip row and its row in the sr-only table.
//
// The layout is deterministic (see `packBubbles`), so an unchanged dataset re-packs to exactly the
// same field. That is also why nothing tweens between two layouts: a refetch replaces the dataset —
// different keys, different ranks — and interpolating positions across that boundary would animate a
// continuity the data does not have. The one transition here IS a spring: the hover lift.

import { type ReactElement, useMemo, useRef, useState } from 'react';
import { useHoverTarget, useSpring } from '../../lib/chartInteraction.js';
import { cn } from '../../lib/cn.js';
import { formatNumber } from '../../lib/format.js';
import { useSize } from '../../lib/useSize.js';
import { ChartNote } from './ChartChrome.js';
import { ChartTooltip, TooltipRow } from './ChartTooltip.js';

/** Category hues, cycled by rank — the same six the rest of the board uses for categories. */
const HUES = [
	'var(--c1)',
	'var(--c2)',
	'var(--c3)',
	'var(--c4)',
	'var(--c5)',
	'var(--c6)',
] as const;

/** Fraction of the plot area the bubbles may cover before every radius is scaled down. */
const AREA_BUDGET = 0.34;
/**
 * Largest bubble, as a fraction of the plot's GEOMETRIC MEAN side — with a hard ceiling against the
 * shorter side so nothing can exceed the box it sits in.
 *
 * It used to be a fraction of the shorter side alone, which is fine for a squarish plot and collapses
 * for a wide one: in a 328 × 78 tile the biggest bubble was capped at 15px across a 328px field, so
 * the chart read as a scattering of specks with most of its ink budget unspent. The mean tracks the
 * area actually available rather than the worst axis.
 */
const MAX_RADIUS_FRACTION = 0.22;
/** Ceiling as a fraction of the shorter side. Below ~0.4 a single dominant value cannot span the plot. */
const MAX_RADIUS_OF_SHORT_SIDE = 0.38;
/** A bubble below this is invisible and unhittable. Disclosed in the footnote; the sr-only table
 * carries every exact number, and the area encoding is exact above the floor. */
const MIN_RADIUS = 3;
/** Gap kept between two bubbles' edges, so touching circles still read as two. */
const PADDING = 1.5;
/** Fixed iteration count — part of what makes the layout reproducible. */
const ITERATIONS = 220;
/** Initial pull back toward the anchor each iteration; annealed to 0 (see `packBubbles`). */
const ANCHOR_PULL = 0.09;

export interface PackInput {
	id: string;
	/** Radius the datum wants, before any fitting. */
	r: number;
	/** Anchor: where the data says this bubble belongs, in plot pixels. */
	ax: number;
	ay: number;
}

export interface PackedBubble {
	id: string;
	x: number;
	y: number;
	r: number;
	/** Where the datum actually sits on the axes, before collision displacement. */
	ax: number;
	ay: number;
}

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Relaxation packing. No d3, no randomness, no dependency.
 *
 * Each bubble starts at its anchor — the point the x and y metrics put it at. Every iteration pushes
 * overlapping pairs apart along their centre line and then pulls each bubble back toward its anchor,
 * with the pull annealed linearly to zero so the final iterations are pure separation and converge.
 *
 * DETERMINISM. The output is a pure function of the input, bit for bit:
 *   1. no `Math.random`, no clock, no DOM read — only the arguments;
 *   2. the working array is sorted by `(r desc, id asc)`, a total order on unique ids, so the pair
 *      sweep visits pairs in the same sequence whatever order the caller passed;
 *   3. the iteration count and the anneal schedule are constants, not convergence tests;
 *   4. two exactly-coincident centres are separated along an angle derived from the pair's indices,
 *      never a random nudge — a random one would re-jitter the whole field on every refetch.
 * Floating-point arithmetic performed in a fixed sequence is reproducible, so identical input yields
 * identical output.
 *
 * NON-OVERLAP is guaranteed, not hoped for. After relaxation the tightest pair fixes a single scale
 * `min(dist / (ri + rj))`; if it is below 1, EVERY radius is multiplied by it. Uniform scaling leaves
 * all relative areas intact — the volume encoding survives — and by construction no pair overlaps
 * afterwards. Containment is preserved too: centres were clamped using the pre-scale radii, so a
 * smaller radius is still inside the box.
 */
export function packBubbles(
	nodes: readonly PackInput[],
	options: { width: number; height: number; iterations?: number },
): PackedBubble[] {
	const { width, height, iterations = ITERATIONS } = options;
	if (nodes.length === 0 || width <= 0 || height <= 0) return [];

	// Canonical order: biggest first (they should claim their anchor and let small ones flow around),
	// ties broken by id so the caller's array order can never change the result.
	const sorted = [...nodes].sort((a, b) => b.r - a.r || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	// Fit the whole field before relaxing: cap the total area and the single largest bubble, so a
	// dominant value cannot swallow the tile and the relaxation has room to actually separate things.
	const wanted = sorted.reduce((sum, n) => sum + Math.PI * n.r * n.r, 0);
	const budget = width * height * AREA_BUDGET;
	let fit = wanted > budget ? Math.sqrt(budget / wanted) : 1;
	const largest = (sorted[0]?.r ?? 0) * fit;
	const maxRadius = Math.min(
		Math.sqrt(width * height) * MAX_RADIUS_FRACTION,
		Math.min(width, height) * MAX_RADIUS_OF_SHORT_SIDE,
	);
	if (largest > maxRadius && largest > 0) fit *= maxRadius / largest;

	const state = sorted.map((n) => ({
		id: n.id,
		ax: n.ax,
		ay: n.ay,
		r: Math.max(MIN_RADIUS, n.r * fit),
		x: n.ax,
		y: n.ay,
	}));

	for (let it = 0; it < iterations; it++) {
		const pull = ANCHOR_PULL * (1 - it / iterations);
		for (let i = 0; i < state.length; i++) {
			for (let j = i + 1; j < state.length; j++) {
				const a = state[i] as (typeof state)[number];
				const b = state[j] as (typeof state)[number];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const minimum = a.r + b.r + PADDING;
				const dist = Math.sqrt(dx * dx + dy * dy);
				if (dist >= minimum) continue;
				let ux: number;
				let uy: number;
				if (dist < 1e-9) {
					// Coincident centres carry no direction. Derive one from the pair's position in
					// the canonical order: reproducible, and spread enough that a column of equal
					// values does not all shove the same way.
					const angle = (((i * 37 + j * 61) % 360) * Math.PI) / 180;
					ux = Math.cos(angle);
					uy = Math.sin(angle);
				} else {
					ux = dx / dist;
					uy = dy / dist;
				}
				const push = (minimum - dist) / 2;
				a.x -= ux * push;
				a.y -= uy * push;
				b.x += ux * push;
				b.y += uy * push;
			}
		}
		for (const n of state) {
			n.x += (n.ax - n.x) * pull;
			n.y += (n.ay - n.y) * pull;
			n.x = clamp(n.x, n.r, Math.max(n.r, width - n.r));
			n.y = clamp(n.y, n.r, Math.max(n.r, height - n.r));
		}
	}

	// One uniform scale makes non-overlap exact (see the doc comment).
	let scale = 1;
	for (let i = 0; i < state.length; i++) {
		for (let j = i + 1; j < state.length; j++) {
			const a = state[i] as (typeof state)[number];
			const b = state[j] as (typeof state)[number];
			const dist = Math.hypot(b.x - a.x, b.y - a.y);
			const need = a.r + b.r;
			if (need > 0 && dist < need) scale = Math.min(scale, dist / need);
		}
	}

	return state.map((n) => ({ id: n.id, x: n.x, y: n.y, r: n.r * scale, ax: n.ax, ay: n.ay }));
}

export interface BubbleDatum {
	key: string;
	label: string;
	/** Bubble AREA is proportional to this. */
	value: number;
	/** Position on the horizontal metric, in that metric's own units. */
	x: number;
	/** Position on the vertical metric, in that metric's own units. */
	y: number;
}

export interface BubbleFieldProps {
	data: readonly BubbleDatum[];
	valueLabel: string;
	xLabel: string;
	yLabel: string;
	formatX: (value: number) => string;
	formatY: (value: number) => string;
	/** Reference value on the x axis (the site-wide rate) — the quadrant divider. */
	xReference?: number | null;
	/** Caption for the sr-only table; it should say what one bubble means. */
	caption: string;
	onSelect?: (key: string) => void;
	activeKey?: string;
	/** Rows the field did not draw, for the honest "showing N of M" footnote. */
	omitted?: number;
}

const FALLBACK = { width: 640, height: 360 };
/**
 * Margins exist here only to seat the two axis TITLES — this chart draws no ticks, so nothing else
 * needs the room. Below `ROTATED_Y_MIN` the rotated y title is longer than the axis it labels, and it
 * overlapped both the bubbles and the x title; there it is set horizontally in the top-left corner
 * instead, and the left margin shrinks to what the plot itself wants.
 */
const ROTATED_Y_MIN = 120;
const MARGIN = { top: 10, right: 12, bottom: 22, left: 26 };
const MARGIN_COMPACT = { top: 14, right: 12, bottom: 18, left: 8 };

/** Nice-ish domain that always contains the data and never collapses to a point. */
function domainOf(values: readonly number[], includeZero: boolean): [number, number] {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const v of values) {
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
	if (includeZero) {
		lo = Math.min(lo, 0);
		hi = Math.max(hi, 0);
	}
	if (hi - lo < 1e-9) {
		const pad = Math.max(Math.abs(hi), 1) * 0.5;
		return [lo - pad, hi + pad];
	}
	const pad = (hi - lo) * 0.12;
	return [lo - pad, hi + pad];
}

export function BubbleField({
	data,
	valueLabel,
	xLabel,
	yLabel,
	formatX,
	formatY,
	xReference,
	caption,
	onSelect,
	activeKey,
	omitted = 0,
}: BubbleFieldProps): ReactElement {
	const wrap = useRef<HTMLDivElement>(null);
	const measured = useSize(wrap);
	const width = measured.width || FALLBACK.width;
	const height = measured.height || FALLBACK.height;
	const [focused, setFocused] = useState<string | null>(null);

	const rotatedY = height >= ROTATED_Y_MIN;
	const margin = rotatedY ? MARGIN : MARGIN_COMPACT;
	const plot = {
		width: Math.max(40, width - margin.left - margin.right),
		height: Math.max(40, height - margin.top - margin.bottom),
	};

	const layout = useMemo(() => {
		// x is a rate compared against the site-wide reference line, not against zero, so the domain
		// is fitted to the data (and that line). Anchoring it at zero pushed every bubble into the
		// right third of the plot and threw away the resolution the axis exists to provide.
		const xDomain = domainOf(
			data.map((d) => d.x).concat(xReference == null ? [] : [xReference]),
			false,
		);
		// y IS read against zero — that is the growing/shrinking divide — so zero always shows.
		const yDomain = domainOf(
			data.map((d) => d.y),
			true,
		);
		const toX = (v: number): number =>
			((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * plot.width;
		// Inverted: up is growth, which is the only reading a reader will attempt.
		const toY = (v: number): number =>
			plot.height - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * plot.height;
		const maxValue = data.reduce((m, d) => Math.max(m, d.value), 0) || 1;
		// r ∝ √value, so AREA is what the eye compares — the whole point of a bubble chart.
		const unit = Math.min(plot.width, plot.height) * 0.5;
		const packed = packBubbles(
			data.map((d) => ({
				id: d.key,
				r: Math.sqrt(d.value / maxValue) * unit,
				ax: toX(d.x),
				ay: toY(d.y),
			})),
			{ width: plot.width, height: plot.height },
		);
		return { packed, toX, toY, xDomain, yDomain };
	}, [data, plot.width, plot.height, xReference]);

	const byKey = useMemo(() => new Map(data.map((d) => [d.key, d])), [data]);
	// Ordered smallest-last so hit-testing prefers the small bubble sitting on top of a large one.
	const hitOrder = useMemo(() => [...layout.packed].sort((a, b) => a.r - b.r), [layout.packed]);

	const { hover, handlers } = useHoverTarget<PackedBubble>(wrap, (localX, localY) => {
		const px = localX - margin.left;
		const py = localY - margin.top;
		for (const b of hitOrder) {
			if ((px - b.x) ** 2 + (py - b.y) ** 2 <= b.r * b.r) return b;
		}
		return null;
	});

	const highlighted = hover?.datum.id ?? focused ?? activeKey ?? null;
	// The one transition: a single spring drives the highlighted bubble's lift. One hook, not one per
	// bubble, and it retargets cleanly when the pointer crosses straight from one bubble to another.
	const lift = useSpring(highlighted == null ? 0 : 1, { stiffness: 220, damping: 24 });

	const hueOf = (index: number): string => HUES[index % HUES.length] as string;
	const rankOf = new Map(data.map((d, i) => [d.key, i]));
	const total = data.reduce((s, d) => s + d.value, 0);
	const hovered = hover ? byKey.get(hover.datum.id) : null;

	return (
		<div ref={wrap} className="relative h-full w-full" {...handlers}>
			{/* "Showing N of M" was disclosed to screen readers and to nobody else. It sits over the
			    bottom margin (the x title is centred, this is flush right) so it costs no plot height. */}
			{omitted > 0 ? (
				<ChartNote className="absolute right-0 bottom-0 z-10">
					+{omitted} smaller not drawn
				</ChartNote>
			) : null}
			<svg
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="xMidYMid meet"
				className="h-full w-full overflow-visible"
				// A group, not an img: the bubbles are real controls when `onSelect` is wired, and
				// role="img" would hide them from assistive tech (the nested-interactive trap the
				// Sankey documents). The numbers live in the sr-only table below either way.
				role={onSelect ? 'group' : 'img'}
				aria-label={caption}
			>
				<g transform={`translate(${margin.left} ${margin.top})`}>
					{/* Quadrant guides. y = 0 is "flat within the range"; the x guide is the site-wide
					    rate, so "left of the line" means below the site average, not below zero. */}
					<line
						x1={0}
						x2={plot.width}
						y1={layout.toY(0)}
						y2={layout.toY(0)}
						stroke="rgb(var(--border))"
						strokeWidth={1}
					/>
					{xReference == null ? null : (
						<line
							x1={layout.toX(xReference)}
							x2={layout.toX(xReference)}
							y1={0}
							y2={plot.height}
							stroke="rgb(var(--border))"
							strokeDasharray="3 3"
							strokeWidth={1}
						/>
					)}
					{layout.packed.map((b) => {
						const datum = byKey.get(b.id);
						if (!datum) return null;
						const rank = rankOf.get(b.id) ?? 0;
						const on = highlighted === b.id;
						const dim = highlighted != null && !on;
						const r = b.r * (on ? 1 + 0.12 * lift : 1);
						const hue = hueOf(rank);
						return (
							<g
								key={b.id}
								role={onSelect ? 'button' : undefined}
								tabIndex={onSelect ? 0 : undefined}
								aria-pressed={onSelect ? activeKey === b.id : undefined}
								aria-label={`${datum.label}: ${formatNumber(datum.value)} ${valueLabel}, ${formatX(datum.x)} ${xLabel}, ${formatY(datum.y)} ${yLabel}`}
								className={cn(
									'transition-opacity duration-150',
									onSelect && 'cursor-pointer',
								)}
								style={{ opacity: dim ? 0.42 : 1 }}
								onFocus={() => setFocused(b.id)}
								onBlur={() => setFocused((f) => (f === b.id ? null : f))}
								onClick={onSelect ? () => onSelect(b.id) : undefined}
								onKeyDown={
									onSelect
										? (e) => {
												if (e.key === 'Enter' || e.key === ' ') {
													e.preventDefault();
													onSelect(b.id);
												}
											}
										: undefined
								}
							>
								<circle
									cx={b.x}
									cy={b.y}
									r={r}
									fill={hue}
									fillOpacity={on ? 0.5 : 0.28}
									stroke={hue}
									strokeWidth={on ? 2 : 1}
								/>
								{/* The anchor: where the axes actually put this bubble before the
								    packing displaced it. Shown only for the highlighted one, so the
								    reader can always check the position they are about to trust. */}
								{on ? (
									<>
										<line
											x1={b.x}
											y1={b.y}
											x2={b.ax}
											y2={b.ay}
											stroke={hue}
											strokeWidth={1}
											strokeDasharray="2 2"
										/>
										<circle cx={b.ax} cy={b.ay} r={2} fill={hue} />
									</>
								) : null}
								{r >= 16 ? (
									<text
										x={b.x}
										y={b.y}
										textAnchor="middle"
										dominantBaseline="central"
										className="pointer-events-none font-medium text-[10px]"
										fill="var(--ink)"
									>
										{datum.label.length > 12
											? `${datum.label.slice(0, 11)}…`
											: datum.label}
									</text>
								) : null}
								<title>{`${datum.label} — ${formatNumber(datum.value)} ${valueLabel}, ${formatX(datum.x)} ${xLabel}, ${formatY(datum.y)} ${yLabel}`}</title>
							</g>
						);
					})}
				</g>
				{/* Axis labels. Both axes are rates, so the labels carry the units, not just a name.
				    Same 10px `--faint` every chart on the board sets its axis text at. */}
				<text
					x={margin.left + plot.width / 2}
					y={height - 3}
					textAnchor="middle"
					className="text-[10px]"
					fill="var(--faint)"
				>
					{xLabel} →
				</text>
				{rotatedY ? (
					<text
						x={0}
						y={0}
						transform={`translate(11 ${margin.top + plot.height / 2}) rotate(-90)`}
						textAnchor="middle"
						className="text-[10px]"
						fill="var(--faint)"
					>
						{yLabel} →
					</text>
				) : (
					// Set flat in the corner rather than rotated: on a short plot the rotated title was
					// taller than the axis it named and crossed both the bubbles and the x title.
					<text
						x={margin.left}
						y={8}
						textAnchor="start"
						className="text-[10px]"
						fill="var(--faint)"
					>
						↑ {yLabel}
					</text>
				)}
			</svg>
			{hover && hovered ? (
				<ChartTooltip
					x={hover.x}
					y={hover.y}
					containerWidth={width}
					containerHeight={height}
				>
					<p className="mb-1 font-semibold">{hovered.label}</p>
					<TooltipRow
						label={valueLabel}
						value={formatNumber(hovered.value)}
						swatch={hueOf(rankOf.get(hovered.key) ?? 0)}
					/>
					<TooltipRow label={xLabel} value={formatX(hovered.x)} />
					<TooltipRow label={yLabel} value={formatY(hovered.y)} />
					<TooltipRow
						label="Share"
						value={total > 0 ? `${Math.round((hovered.value / total) * 100)}%` : '—'}
					/>
				</ChartTooltip>
			) : null}
			<table className="sr-only">
				<caption>
					{caption} Area is {valueLabel}; horizontal position is {xLabel}; vertical
					position is {yLabel}. Bubbles are nudged apart where they would overlap, so read
					the exact values here.
					{omitted > 0
						? ` ${omitted} smaller ${omitted === 1 ? 'value is' : 'values are'} not drawn; they are listed below.`
						: ''}
				</caption>
				<thead>
					<tr>
						<th scope="col">Segment</th>
						<th scope="col">{valueLabel}</th>
						<th scope="col">{xLabel}</th>
						<th scope="col">{yLabel}</th>
					</tr>
				</thead>
				<tbody>
					{data.map((d) => (
						<tr key={d.key}>
							<th scope="row">{d.label}</th>
							<td>{formatNumber(d.value)}</td>
							<td>{formatX(d.x)}</td>
							<td>{formatY(d.y)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
