// A small dependency-free layered Sankey (flow) diagram. Nodes are assigned to columns; each node's
// height is proportional to its throughput, links are gradient bezier bands whose thickness tracks their
// value. Layout is deterministic and fills its container via a viewBox. It is interactive: hovering a node
// or ribbon highlights that node's upstream+downstream subgraph and dims the rest; clicking a node calls
// `onNodeClick` (the caller decides expand vs. isolate); `isolatedId` pins a highlight. When the graph
// changes (a device expands, the range changes) the node rects and ribbon paths tween from the old layout
// to the new via rAF — the display is seeded from the target on first mount so a no-JS/first render is
// already correct.

import { type ReactElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';

export interface SankeyNode {
	id: string;
	label: string;
	column: number;
}

export interface SankeyLink {
	source: string;
	target: string;
	value: number;
}

const W = 600;
const H = 320;
const NODE_W = 12;
const GAP = 10; // vertical gap between stacked nodes in a column
const DIM = 0.16; // opacity of nodes/ribbons outside the highlighted subgraph
const TWEEN_MS = 420;

interface PlacedNode {
	id: string;
	label: string;
	column: number;
	x: number;
	y: number;
	h: number;
	value: number;
}
interface Ribbon {
	key: string;
	source: string;
	target: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	mx: number;
	width: number;
}
interface Layout {
	nodes: PlacedNode[];
	ribbons: Ribbon[];
	lastColumn: number;
}

/** Lay out nodes column-by-column, height ∝ throughput, then compute per-link source/target offsets so
 * bands stack within each node without overlapping. Returns placed nodes + ribbon endpoint coordinates
 * (numbers, not a path string) so the render can interpolate them frame-by-frame. */
function layout(nodes: SankeyNode[], links: SankeyLink[], h: number): Layout {
	const columns = [...new Set(nodes.map((n) => n.column))].sort((a, b) => a - b);
	const outByNode = new Map<string, number>();
	const inByNode = new Map<string, number>();
	for (const l of links) {
		outByNode.set(l.source, (outByNode.get(l.source) ?? 0) + l.value);
		inByNode.set(l.target, (inByNode.get(l.target) ?? 0) + l.value);
	}
	const throughput = (id: string): number =>
		Math.max(outByNode.get(id) ?? 0, inByNode.get(id) ?? 0);

	const placed = new Map<string, PlacedNode>();
	const colX = (c: number): number =>
		columns.length <= 1 ? 0 : (columns.indexOf(c) / (columns.length - 1)) * (W - NODE_W);
	for (const c of columns) {
		const colNodes = nodes.filter((n) => n.column === c);
		const total = colNodes.reduce((s, n) => s + throughput(n.id), 0) || 1;
		const usable = h - GAP * Math.max(0, colNodes.length - 1);
		let y = 0;
		for (const n of colNodes.sort((a, b) => throughput(b.id) - throughput(a.id))) {
			const h = Math.max(2, (throughput(n.id) / total) * usable);
			placed.set(n.id, {
				...n,
				x: colX(c),
				y,
				h,
				value: throughput(n.id),
			});
			y += h + GAP;
		}
	}

	// Stack link endpoints within each node (source side by outgoing order, target by incoming order).
	const srcOffset = new Map<string, number>();
	const tgtOffset = new Map<string, number>();
	const ribbons: Ribbon[] = links
		.filter((l) => placed.has(l.source) && placed.has(l.target))
		.map((l) => {
			const s = placed.get(l.source) as PlacedNode;
			const t = placed.get(l.target) as PlacedNode;
			const so = srcOffset.get(l.source) ?? 0;
			const to = tgtOffset.get(l.target) ?? 0;
			const bandS = (l.value / (outByNode.get(l.source) ?? l.value)) * s.h;
			const bandT = (l.value / (inByNode.get(l.target) ?? l.value)) * t.h;
			srcOffset.set(l.source, so + bandS);
			tgtOffset.set(l.target, to + bandT);
			const x0 = s.x + NODE_W;
			const x1 = t.x;
			return {
				key: `${l.source}->${l.target}`,
				source: l.source,
				target: l.target,
				x0,
				y0: s.y + so + bandS / 2,
				x1,
				y1: t.y + to + bandT / 2,
				mx: (x0 + x1) / 2,
				width: Math.max(1, Math.min(bandS, bandT)),
			};
		});

	return {
		nodes: [...placed.values()],
		ribbons,
		lastColumn: columns.length ? (columns[columns.length - 1] ?? 0) : 0,
	};
}

/** Every node reachable from `id` upstream (feeds it) or downstream (it feeds), plus `id` itself. */
function connectedTo(id: string, links: SankeyLink[]): Set<string> {
	const set = new Set<string>([id]);
	for (const [get, other] of [
		[(l: SankeyLink) => l.source, (l: SankeyLink) => l.target] as const,
		[(l: SankeyLink) => l.target, (l: SankeyLink) => l.source] as const,
	]) {
		let frontier = [id];
		while (frontier.length) {
			const next: string[] = [];
			for (const l of links) {
				if (frontier.includes(get(l)) && !set.has(other(l))) {
					set.add(other(l));
					next.push(other(l));
				}
			}
			frontier = next;
		}
	}
	return set;
}

function reducedMotion(): boolean {
	return (
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolate the whole layout toward `to`. Nodes/ribbons present in both tween their coordinates; a
 * node/ribbon new in `to` (a device just expanded) grows from zero height/width; anything only in `from`
 * is dropped (it snaps out). The rendered set is always `to`'s. */
function interpolate(from: Layout, to: Layout, t: number): Layout {
	const fn = new Map(from.nodes.map((n) => [n.id, n]));
	const fr = new Map(from.ribbons.map((r) => [r.key, r]));
	return {
		lastColumn: to.lastColumn,
		nodes: to.nodes.map((n) => {
			const a = fn.get(n.id) ?? { ...n, h: 0 };
			return {
				...n,
				x: lerp(a.x, n.x, t),
				y: lerp(a.y, n.y, t),
				h: lerp(a.h, n.h, t),
			};
		}),
		ribbons: to.ribbons.map((r) => {
			const a = fr.get(r.key) ?? { ...r, width: 0 };
			return {
				...r,
				x0: lerp(a.x0, r.x0, t),
				y0: lerp(a.y0, r.y0, t),
				x1: lerp(a.x1, r.x1, t),
				y1: lerp(a.y1, r.y1, t),
				mx: lerp(a.mx, r.mx, t),
				width: lerp(a.width, r.width, t),
			};
		}),
	};
}

const ribbonPath = (r: Ribbon): string =>
	`M${r.x0},${r.y0} C${r.mx},${r.y0} ${r.mx},${r.y1} ${r.x1},${r.y1}`;

export function Sankey({
	nodes,
	links,
	onNodeClick,
	isolatedId,
	className,
}: {
	nodes: SankeyNode[];
	links: SankeyLink[];
	onNodeClick?: (id: string) => void;
	isolatedId?: string | null;
	className?: string;
}): ReactElement | null {
	const gid = useId();
	const svgRef = useRef<SVGSVGElement>(null);
	// Match the viewBox height to the container's real aspect ratio so the diagram fills the tile instead
	// of letterboxing — the layout then spreads its node stacks across the full measured height.
	const [vbH, setVbH] = useState(H);
	useEffect(() => {
		const el = svgRef.current;
		if (!el) return;
		const measure = (): void => {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0)
				setVbH(Math.max(160, ((W + 128) * r.height) / r.width - 16));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const target = useMemo(
		() => (nodes.length === 0 || links.length === 0 ? null : layout(nodes, links, vbH)),
		[nodes, links, vbH],
	);
	// The displayed layout is always derived from the CURRENT target's structure, tweened toward it by a
	// progress scalar — so a graph change shows the new nodes/ribbons immediately (positions animate, not
	// the structure). This degrades correctly where rAF never advances (a hidden tab, the tests): progress
	// stays 0 but the target's shape is already on screen. `from` is what was showing when the tween began.
	const [prevTarget, setPrevTarget] = useState(target);
	const [progress, setProgress] = useState(1);
	const fromRef = useRef<Layout | null>(target);
	const displayRef = useRef<Layout | null>(target);
	const pendingTween = useRef(false);
	const raf = useRef(0);
	const [hovered, setHovered] = useState<string | null>(null);

	if (target !== prevTarget) {
		// Adjust state during render (React's supported pattern) so the new structure paints this commit.
		const instant = !prevTarget || reducedMotion();
		fromRef.current = displayRef.current ?? prevTarget ?? target;
		setPrevTarget(target);
		setProgress(instant ? 1 : 0);
		pendingTween.current = !instant;
	}

	const display = target
		? interpolate(fromRef.current ?? target, target, 1 - (1 - progress) ** 3)
		: null;
	displayRef.current = display;

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the committed target; the tween ramps the progress the render above reset
	useEffect(() => {
		if (!pendingTween.current) return;
		pendingTween.current = false;
		const start = performance.now();
		const tick = (now: number): void => {
			// Clamped at BOTH ends. A rAF callback is handed the frame's start time, which can
			// precede the `performance.now()` taken when this effect ran — so `now - start` is
			// occasionally negative on the first tick. Progress then went negative, the eased
			// `t = 1 - (1 - progress) ** 3` went negative with it, and `lerp(0, h, t)` for a node
			// that is new in this target produced a NEGATIVE height: five "<rect> attribute height:
			// A negative value is not valid" errors per mount. Reproduced on the Overview's Traffic
			// flow tile at 375px, where the carousel re-measures often enough to hit it every time.
			setProgress(Math.max(0, Math.min(1, (now - start) / TWEEN_MS)));
			if (now - start < TWEEN_MS) raf.current = requestAnimationFrame(tick);
		};
		raf.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf.current);
	}, [prevTarget]);

	if (!target || !display) return null;

	const highlightId = hovered ?? isolatedId ?? null;
	const hi = highlightId ? connectedTo(highlightId, links) : null;
	const nodeOn = (id: string): boolean => !hi || hi.has(id);
	const ribbonOn = (r: Ribbon): boolean => !hi || (hi.has(r.source) && hi.has(r.target));
	const clickable = Boolean(onNodeClick);

	return (
		<svg
			ref={svgRef}
			viewBox={`-64 -8 ${W + 128} ${vbH + 16}`}
			preserveAspectRatio="xMidYMid meet"
			className={cn('h-full w-full', className)}
			// role="img" makes the entire subtree presentational, so with clickable nodes this diagram
			// was hiding its own controls from assistive tech (axe: nested-interactive). An interactive
			// diagram is a group of controls; only the static variant is an image. Either way the
			// numbers are carried by the sr-only flow table the caller renders alongside.
			role={clickable ? 'group' : 'img'}
			aria-label="Traffic flow diagram"
			onMouseLeave={() => setHovered(null)}
		>
			<defs>
				<linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
					<stop offset="0%" stopColor="var(--c1)" stopOpacity="0.5" />
					<stop offset="55%" stopColor="var(--c2)" stopOpacity="0.32" />
					<stop offset="100%" stopColor="var(--c3)" stopOpacity="0.22" />
				</linearGradient>
			</defs>
			{display.ribbons.map((r) => (
				<path
					key={r.key}
					d={ribbonPath(r)}
					fill="none"
					stroke={`url(#${gid})`}
					strokeWidth={r.width}
					className="transition-opacity duration-200"
					style={{ opacity: ribbonOn(r) ? 1 : DIM }}
					onMouseEnter={() => setHovered(r.source)}
				>
					<title>{r.key.replace('->', ' → ')}</title>
				</path>
			))}
			{/* A ribbon is a QUANTITY OF TRAFFIC, and the one thing a static band cannot show is that it
			    has a direction. On hover the highlighted subgraph gets a light travelling down it —
			    source to target, at one speed for every ribbon, so the eye reads the path rather than
			    the width. Only while highlighted: a board that shimmers at rest is worse than a still
			    one, and this is the moment the reader has actually asked "where does this go".
			    Decoration on top of paths that already carry the title and the sr-only table, so it is
			    pointer-transparent and simply not rendered when motion is not wanted. */}
			{hi && !reducedMotion()
				? display.ribbons.filter(ribbonOn).map((r) => (
						<path
							key={`${r.key}-flow`}
							d={ribbonPath(r)}
							fill="none"
							stroke="var(--c3)"
							strokeOpacity={0.55}
							strokeWidth={Math.min(r.width * 0.5, 2.5)}
							strokeLinecap="round"
							strokeDasharray="8 56"
							// No aria-hidden: this path carries no title, no role and no tab
							// stop, so it is already nothing to the accessibility tree — and
							// the attribute trips the focusable-hidden rule on a graphic
							// inside an interactive group.
							className="facet-flow pointer-events-none"
						/>
					))
				: null}
			{display.nodes.map((n) => {
				const first = n.column === 0;
				const last = n.column === display.lastColumn;
				const on = nodeOn(n.id);
				return (
					<g
						key={n.id}
						// No focus:outline-none: it suppressed the shell's token focus outline and left
						// only a stroke recolour on the rect, which is a colour-alone indicator.
						className={cn(
							'transition-opacity duration-200 focus-visible:[&>rect]:stroke-accent-700',
							clickable && 'cursor-pointer',
						)}
						style={{ opacity: on ? 1 : DIM }}
						role={clickable ? 'button' : undefined}
						tabIndex={clickable ? 0 : undefined}
						aria-label={clickable ? `Flow node ${n.label}` : undefined}
						onMouseEnter={() => setHovered(n.id)}
						onFocus={clickable ? () => setHovered(n.id) : undefined}
						onBlur={clickable ? () => setHovered(null) : undefined}
						onClick={clickable ? () => onNodeClick?.(n.id) : undefined}
						onKeyDown={
							clickable
								? (e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											onNodeClick?.(n.id);
										}
									}
								: undefined
						}
					>
						<rect
							x={n.x}
							y={n.y}
							width={NODE_W}
							height={n.h}
							rx={2}
							style={{ fill: 'var(--d1)' }}
						/>
						{first || last ? (
							<text
								x={first ? n.x - 6 : n.x + NODE_W + 6}
								y={n.y + n.h / 2}
								textAnchor={first ? 'end' : 'start'}
								dominantBaseline="central"
								className={cn(
									'text-[11px] font-medium',
									'fill-[color:var(--muted)]',
								)}
							>
								{n.label}
							</text>
						) : n.h >= 12 ? (
							// Middle column: label to the right of the node on an opaque pill so it reads over the
							// ribbons. Skip when the node is too short; its <title> carries it.
							<>
								<rect
									x={n.x + NODE_W + 4}
									y={n.y + n.h / 2 - 8}
									width={n.label.length * 6 + 8}
									height={16}
									rx={4}
									className="fill-white/85"
								/>
								<text
									x={n.x + NODE_W + 8}
									y={n.y + n.h / 2}
									textAnchor="start"
									dominantBaseline="central"
									className="fill-neutral-600 text-[11px] font-medium"
								>
									{n.label}
								</text>
							</>
						) : null}
						<title>{n.label}</title>
					</g>
				);
			})}
		</svg>
	);
}
