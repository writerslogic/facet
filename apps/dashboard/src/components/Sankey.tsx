// A small dependency-free layered Sankey (flow) diagram. Nodes are assigned to columns; each node's
// height is proportional to its throughput, links are gradient bezier bands whose thickness tracks
// their value. Layout is deterministic (stable across renders) and fills its container via a viewBox.
// Purely presentational — the caller supplies nodes (with a column index) and weighted links.

import { type ReactElement, useId } from 'react';
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

interface Placed {
	id: string;
	label: string;
	column: number;
	x: number;
	y: number;
	h: number;
	value: number;
}

/** Lay out nodes column-by-column, height ∝ throughput, then compute per-link source/target offsets so
 * bands stack within each node without overlapping. Returns placed nodes + link ribbon path data. */
function layout(nodes: SankeyNode[], links: SankeyLink[]) {
	const columns = [...new Set(nodes.map((n) => n.column))].sort((a, b) => a - b);
	const outByNode = new Map<string, number>();
	const inByNode = new Map<string, number>();
	for (const l of links) {
		outByNode.set(l.source, (outByNode.get(l.source) ?? 0) + l.value);
		inByNode.set(l.target, (inByNode.get(l.target) ?? 0) + l.value);
	}
	const throughput = (id: string): number =>
		Math.max(outByNode.get(id) ?? 0, inByNode.get(id) ?? 0);

	const placed = new Map<string, Placed>();
	const colX = (c: number): number =>
		columns.length <= 1 ? 0 : (c / (columns.length - 1)) * (W - NODE_W);
	for (const c of columns) {
		const colNodes = nodes.filter((n) => n.column === c);
		const total = colNodes.reduce((s, n) => s + throughput(n.id), 0) || 1;
		const usable = H - GAP * Math.max(0, colNodes.length - 1);
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
	const ribbons = links
		.filter((l) => placed.has(l.source) && placed.has(l.target))
		.map((l) => {
			const s = placed.get(l.source) as Placed;
			const t = placed.get(l.target) as Placed;
			const so = srcOffset.get(l.source) ?? 0;
			const to = tgtOffset.get(l.target) ?? 0;
			const bandS = (l.value / (outByNode.get(l.source) ?? l.value)) * s.h;
			const bandT = (l.value / (inByNode.get(l.target) ?? l.value)) * t.h;
			srcOffset.set(l.source, so + bandS);
			tgtOffset.set(l.target, to + bandT);
			const x0 = s.x + NODE_W;
			const x1 = t.x;
			const y0 = s.y + so + bandS / 2;
			const y1 = t.y + to + bandT / 2;
			const mx = (x0 + x1) / 2;
			return {
				key: `${l.source}->${l.target}`,
				d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`,
				width: Math.max(1, Math.min(bandS, bandT)),
			};
		});

	return { placed: [...placed.values()], ribbons };
}

export function Sankey({
	nodes,
	links,
	className,
}: {
	nodes: SankeyNode[];
	links: SankeyLink[];
	className?: string;
}): ReactElement | null {
	const gid = useId();
	if (nodes.length === 0 || links.length === 0) return null;
	const { placed, ribbons } = layout(nodes, links);
	const lastColumn = Math.max(...nodes.map((n) => n.column));

	return (
		<svg
			viewBox={`-64 -8 ${W + 128} ${H + 16}`}
			preserveAspectRatio="xMidYMid meet"
			className={cn('h-full w-full', className)}
			role="img"
			aria-label="Traffic flow diagram"
		>
			<defs>
				<linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
					<stop offset="0%" stopColor="#6366f1" stopOpacity="0.4" />
					<stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.2" />
				</linearGradient>
			</defs>
			{ribbons.map((r) => (
				<path key={r.key} d={r.d} fill="none" stroke={`url(#${gid})`} strokeWidth={r.width}>
					<title>{r.key.replace('->', ' → ')}</title>
				</path>
			))}
			{placed.map((n) => {
				const first = n.column === 0;
				const last = n.column === lastColumn;
				return (
					<g key={n.id}>
						<rect
							x={n.x}
							y={n.y}
							width={NODE_W}
							height={n.h}
							rx={2}
							className="fill-accent-500"
						/>
						{first || last ? (
							<text
								x={first ? n.x - 6 : n.x + NODE_W + 6}
								y={n.y + n.h / 2}
								textAnchor={first ? 'end' : 'start'}
								dominantBaseline="central"
								className="fill-neutral-500 text-[11px] font-medium"
							>
								{n.label}
							</text>
						) : (
							<text
								x={n.x + NODE_W / 2}
								y={n.y - 3}
								textAnchor="middle"
								className="fill-neutral-400 text-[10px]"
							>
								{n.label}
							</text>
						)}
					</g>
				);
			})}
		</svg>
	);
}
