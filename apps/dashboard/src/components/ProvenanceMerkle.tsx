// The inclusion proof, drawn as what it actually is: a walk from one record up to the number the
// deployment signed. Every hash on the diagram was recomputed in this browser (see lib/provenance.ts);
// nothing here is decoration over a server's say-so.
//
// WHY A DIAGRAM AT ALL: an inclusion proof is a list of hex strings, and a list of hex strings
// persuades nobody. The shape is the argument — each step folds the running fingerprint together with
// exactly one neighbour, the neighbour's side is fixed by the record's position, and after a handful
// of steps you land on a number that was signed before you asked. Stepping through it is what makes
// "you can check this yourself" concrete.
//
// The SVG is aria-hidden and carries a full sr-only table beside it, the same contract WorldMap and
// the Sankey use. Stepping is keyboard-operable through real buttons, never the diagram alone.

import { type ReactElement, useRef } from 'react';
import { useDrillPath, useHoverTarget, useSpring } from '../lib/chartInteraction.js';
import type { FoldResult } from '../lib/provenance.js';
import { useSize } from '../lib/useSize.js';
import { ChartTooltip, TooltipRow } from './charts/ChartTooltip.js';

/** Vertical distance between levels of the walk. */
const ROW = 62;
const VIEW_W = 320;
const SPINE_X = 160;
const NODE_W = 92;
const NODE_H = 26;

/** A drawn node: the running fingerprint on the spine, a supplied sibling, a peak, or the root. */
interface Node {
	key: string;
	kind: 'leaf' | 'fold' | 'sibling' | 'peak' | 'root';
	label: string;
	hash: string;
	/** Which step must be reached before this node is part of the proven walk. */
	at: number;
	x: number;
	y: number;
}

/** Truncate a hash for a fixed-width slot, keeping both ends so two hashes stay distinguishable. */
function short(hash: string): string {
	return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

/** Build the whole picture up front: nodes, the edges between them, and the canvas height. */
function layout(fold: FoldResult): { nodes: Node[]; edges: [Node, Node][]; height: number } {
	const levels = fold.steps.length + 1;
	// Spine levels, then a row for the accumulator peaks, then the signed root.
	const height = (levels + 2) * ROW + 24;
	const y = (level: number): number => height - 34 - level * ROW;

	const spine: Node[] = [
		{
			key: 'leaf',
			kind: 'leaf',
			label: 'this record',
			hash: fold.leaf,
			at: 0,
			x: SPINE_X,
			y: y(0),
		},
		...fold.steps.map<Node>((s) => ({
			key: `fold-${s.step}`,
			kind: 'fold',
			label: `combined ${s.step}`,
			hash: s.to,
			at: s.step,
			x: SPINE_X,
			y: y(s.step),
		})),
	];
	const siblings = fold.steps.map<Node>((s) => ({
		key: `sib-${s.step}`,
		kind: 'sibling',
		label: `neighbour ${s.step}`,
		hash: s.sibling,
		at: s.step,
		// The side is not a layout choice: it is the side the tree puts the neighbour on.
		x: s.side === 'left' ? SPINE_X - 108 : SPINE_X + 108,
		y: y(s.step - 1),
	}));

	const peakY = y(levels);
	const peakStep = fold.steps.length + 1;
	const peaks = fold.peaks.map<Node>((h, i) => ({
		key: `peak-${i}`,
		kind: 'peak',
		label: `summit ${i + 1}`,
		hash: h,
		at: peakStep,
		x:
			fold.peaks.length === 1
				? SPINE_X
				: 40 + (i * (VIEW_W - 80)) / Math.max(fold.peaks.length - 1, 1),
		y: peakY,
	}));
	const root: Node = {
		key: 'root',
		kind: 'root',
		label: 'signed summary',
		hash: fold.anchorRoot,
		at: peakStep + 1,
		x: SPINE_X,
		y: y(levels + 1),
	};

	const edges: [Node, Node][] = [];
	for (let i = 0; i < fold.steps.length; i++) {
		const child = spine[i] as Node;
		const parent = spine[i + 1] as Node;
		edges.push([child, parent]);
		edges.push([siblings[i] as Node, parent]);
	}
	const top = spine[spine.length - 1] as Node;
	for (const p of peaks) {
		// Only the summit this walk reaches is connected to it; the others are context.
		if (fold.matchedPeak !== null && p === peaks[fold.matchedPeak]) edges.push([top, p]);
		edges.push([p, root]);
	}
	return { nodes: [...spine, ...siblings, ...peaks, root], edges, height };
}

/** Plain-language caption for the step the reader is on. */
function caption(fold: FoldResult, step: number): string {
	if (step === 0) {
		return 'Start at the record for this hour. Its fingerprint is the one the log stored.';
	}
	if (step <= fold.steps.length) {
		const s = fold.steps[step - 1];
		if (!s) return '';
		return `Fold the running fingerprint together with the neighbour the log supplies on the ${s.side}, tagged with position ${s.position} so it cannot be reused anywhere else in the tree. One SHA-256, one new fingerprint.`;
	}
	if (step === fold.steps.length + 1) {
		return fold.matchedPeak === null
			? 'The walk should now equal one of the log’s summits. It equals none of them, so this proof does not hold.'
			: `The result is summit ${fold.matchedPeak + 1} of ${fold.peaks.length} — one of the peaks the log keeps as its running summary.`;
	}
	return fold.computedRoot === fold.anchorRoot
		? 'Hash the summits together and you get the signed summary, unchanged. To fake this number, someone would have to find a SHA-256 collision.'
		: 'Hashing the summits together does not reproduce the signed summary. This proof does not hold.';
}

export function ProvenanceMerkle({
	fold,
	failed,
}: {
	fold: FoldResult;
	/** Drives the failing visual state, so a broken proof is never drawn in the passing colours. */
	failed: boolean;
}): ReactElement {
	const { nodes, edges, height } = layout(fold);
	const lastStep = fold.steps.length + 2;
	// The proof IS a walk, so it uses the same stack every drill-down on the board uses: `current` is
	// how far along we are, `back` retraces, `jumpTo` moves to a step already reached.
	const walk = useDrillPath<number>(0);
	const step = Math.min(walk.current, lastStep);
	const boxRef = useRef<HTMLDivElement>(null);
	const size = useSize(boxRef);

	/** Move to `to`, pushing every step in between so Back retraces the walk one fold at a time. */
	function goTo(to: number): void {
		if (to <= step) {
			walk.jumpTo(to);
			return;
		}
		for (let i = step + 1; i <= Math.min(to, lastStep); i++) walk.drillTo(i);
	}

	// The highlight ring rides a spring between rows: retargeting mid-flight (tapping Next twice
	// quickly) bends rather than snapping, and reduced-motion callers get no animation at all.
	// Prefer the node the step is ABOUT: the matched summit at the summit step, not the first drawn.
	const active =
		nodes.find(
			(n) =>
				n.at === step &&
				(n.kind === 'peak'
					? n.key === `peak-${fold.matchedPeak ?? 0}`
					: n.kind !== 'sibling'),
		) ?? (nodes[0] as Node);
	const ringY = useSpring(active.y);

	// Read the measured width through the render closure of the *current* size: the diagram scales
	// with its container, so a hit test in view-box units has to undo that scale.
	const scale = size.width > 0 ? size.width / VIEW_W : 1;
	const { hover, handlers } = useHoverTarget<Node>(boxRef, (lx, ly) => {
		const x = lx / scale;
		const y = ly / scale;
		return (
			nodes.find(
				(n) =>
					Math.abs(x - n.x) <= NODE_W / 2 + 4 && Math.abs(y - (n.y + NODE_H / 2)) <= 16,
			) ?? null
		);
	});

	function nodeTone(n: Node): { stroke: string; fill: string; ink: string; done: boolean } {
		const done = n.at <= step;
		if (!done) {
			return {
				stroke: 'rgb(var(--border))',
				fill: 'transparent',
				ink: 'var(--faint)',
				done: false,
			};
		}
		const tone = failed ? 'var(--neg)' : 'var(--pos)';
		return {
			stroke: n.at === step ? 'rgb(var(--accent-rgb))' : tone,
			fill: `color-mix(in srgb, ${n.at === step ? 'rgb(var(--accent-rgb))' : tone} 16%, transparent)`,
			ink: 'var(--ink)',
			done: true,
		};
	}

	return (
		<div>
			<div className="mb-3 flex flex-wrap items-center gap-1.5" data-chrome>
				<button
					type="button"
					className="btn-ghost rounded-md px-2 py-1 text-xs"
					onClick={walk.back}
					disabled={step === 0}
				>
					Back
				</button>
				<button
					type="button"
					className="btn-accent rounded-md px-2 py-1 text-xs"
					onClick={() => goTo(step + 1)}
					disabled={step === lastStep}
				>
					Next step
				</button>
				<span className="ml-1 text-[11px] text-[color:var(--muted)]">
					Step {step} of {lastStep}
				</span>
				<div className="ml-auto flex flex-wrap gap-1">
					{Array.from({ length: lastStep + 1 }, (_, i) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: the index IS the step number — a fixed sequence 0..n whose identity is exactly its position
							key={i}
							type="button"
							aria-label={`Go to step ${i} of ${lastStep}`}
							aria-current={i === step ? 'step' : undefined}
							onClick={() => goTo(i)}
							className={`h-6 w-6 rounded text-[11px] tabular-nums ${
								i === step ? 'chip-active' : 'btn-ghost'
							}`}
						>
							{i}
						</button>
					))}
				</div>
			</div>

			{/* Pointer hover is a supplement only: the diagram is aria-hidden, and every value it shows
			    also lives in the sr-only table and the step caption, both reachable by keyboard. */}
			<div
				ref={boxRef}
				className="relative"
				onPointerMove={handlers.onPointerMove}
				onPointerLeave={handlers.onPointerLeave}
			>
				<svg
					viewBox={`0 0 ${VIEW_W} ${height}`}
					className="h-auto w-full"
					aria-hidden="true"
					role="img"
				>
					<title>Inclusion proof walk</title>
					{edges.map(([a, b]) => (
						<line
							key={`${a.key}->${b.key}`}
							x1={a.x}
							y1={a.y}
							x2={b.x}
							y2={b.y + NODE_H}
							stroke={
								b.at <= step
									? 'rgb(var(--accent-rgb) / 0.55)'
									: 'rgb(var(--border))'
							}
							strokeWidth={1.5}
							strokeDasharray={b.at <= step ? undefined : '3 3'}
						/>
					))}
					<rect
						x={active.x - NODE_W / 2 - 5}
						y={ringY - 5}
						width={NODE_W + 10}
						height={NODE_H + 10}
						rx={9}
						fill="none"
						stroke="rgb(var(--accent-rgb))"
						strokeWidth={1.5}
						opacity={0.7}
					/>
					{nodes.map((n) => {
						const tone = nodeTone(n);
						return (
							<g key={n.key}>
								<rect
									x={n.x - NODE_W / 2}
									y={n.y}
									width={NODE_W}
									height={NODE_H}
									rx={6}
									fill={tone.fill}
									stroke={tone.stroke}
									strokeWidth={1.25}
									strokeDasharray={tone.done ? undefined : '3 3'}
								/>
								<text
									x={n.x}
									y={n.y + 11}
									textAnchor="middle"
									fontSize="8.5"
									fill={tone.ink}
									fontWeight={n.kind === 'root' ? 600 : 400}
								>
									{tone.done ? '✓ ' : ''}
									{n.label}
								</text>
								<text
									x={n.x}
									y={n.y + 21}
									textAnchor="middle"
									fontSize="8"
									fill="var(--muted)"
									fontFamily="ui-monospace, monospace"
								>
									{short(n.hash)}
								</text>
							</g>
						);
					})}
				</svg>
				{hover ? (
					<ChartTooltip
						x={hover.x}
						y={hover.y}
						containerWidth={size.width}
						containerHeight={size.height}
					>
						<TooltipRow label={hover.datum.label} value={hover.datum.kind} />
						<div className="mt-1 break-all font-mono text-[10px] text-[color:var(--muted)]">
							{hover.datum.hash}
						</div>
					</ChartTooltip>
				) : null}
			</div>

			<p className="mt-3 text-xs leading-relaxed text-[color:var(--muted)]" data-chrome>
				<span className="font-medium text-[color:var(--ink)]">Step {step}.</span>{' '}
				{caption(fold, step)}
			</p>
			{step > 0 && step <= fold.steps.length ? (
				<dl className="mt-2 space-y-1 text-[11px]">
					<div className="flex gap-2">
						<dt className="w-20 shrink-0 text-[color:var(--faint)]">Neighbour</dt>
						<dd
							data-selectable
							className="min-w-0 break-all font-mono text-[color:var(--ink)]"
						>
							{fold.steps[step - 1]?.sibling}
						</dd>
					</div>
					<div className="flex gap-2">
						<dt className="w-20 shrink-0 text-[color:var(--faint)]">Result</dt>
						<dd
							data-selectable
							className="min-w-0 break-all font-mono text-[color:var(--ink)]"
						>
							{fold.steps[step - 1]?.to}
						</dd>
					</div>
				</dl>
			) : null}

			<table className="sr-only">
				<caption>
					The inclusion proof as a table: each step folds the running fingerprint together
					with one neighbouring fingerprint, ending at the signed summary.
				</caption>
				<thead>
					<tr>
						<th scope="col">Step</th>
						<th scope="col">Neighbour side</th>
						<th scope="col">Neighbour fingerprint</th>
						<th scope="col">Resulting fingerprint</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">0</th>
						<td>none</td>
						<td>none</td>
						<td>{fold.leaf}</td>
					</tr>
					{fold.steps.map((s) => (
						<tr key={s.step}>
							<th scope="row">{s.step}</th>
							<td>{s.side}</td>
							<td>{s.sibling}</td>
							<td>{s.to}</td>
						</tr>
					))}
					<tr>
						<th scope="row">{fold.steps.length + 1}</th>
						<td>summit match</td>
						<td>
							{fold.matchedPeak === null
								? 'no summit matched'
								: `summit ${fold.matchedPeak + 1} of ${fold.peaks.length}`}
						</td>
						<td>{fold.peak}</td>
					</tr>
					<tr>
						<th scope="row">{fold.steps.length + 2}</th>
						<td>summits hashed together</td>
						<td>{fold.peaks.join(' ')}</td>
						<td>{fold.computedRoot}</td>
					</tr>
				</tbody>
			</table>
		</div>
	);
}
