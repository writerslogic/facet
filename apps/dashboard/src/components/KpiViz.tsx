// Distinct mini-visualizations for the KPI tiles, so no two metric tiles read alike (the founder's
// "no box the same" rule). Pageviews → a filled step "horizon" skyline; Visitors → a radial ratio gauge;
// Events → prism columns. All dependency-free inline SVG, prism-toned, and legible on the dark board.

import { type ReactElement, useId } from 'react';
import { cn } from '../lib/cn.js';

const PRISM = ['var(--c1)', 'var(--c2)', 'var(--c3)'] as const;

/** A filled step-area silhouette (a cut skyline) — a deliberately blockier language than the smooth
 * sparkline so Pageviews reads as its own chart. */
export function HorizonSpark({
	values,
	className,
}: {
	values: number[];
	className?: string;
}): ReactElement | null {
	const gid = useId();
	if (values.length < 2) return null;
	const w = 100;
	const h = 32;
	const max = Math.max(...values);
	const min = Math.min(...values);
	const span = max - min || 1;
	const step = w / values.length;
	// Build a stepped top edge (one flat tread per bucket), then close to the baseline for the fill.
	const pts: string[] = [`0,${h}`];
	values.forEach((v, i) => {
		const y = h - ((v - min) / span) * (h - 2) - 1;
		const x0 = i * step;
		const x1 = (i + 1) * step;
		pts.push(`${x0.toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${y.toFixed(1)}`);
	});
	pts.push(`${w},${h}`);
	const area = pts.join(' ');
	const top = pts.slice(1, -1).join(' ');
	return (
		<svg
			viewBox={`0 0 ${w} ${h}`}
			preserveAspectRatio="none"
			className={cn('overflow-visible', className)}
			aria-hidden="true"
		>
			<defs>
				<linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={PRISM[2]} stopOpacity="0.55" />
					<stop offset="55%" stopColor={PRISM[1]} stopOpacity="0.3" />
					<stop offset="100%" stopColor={PRISM[0]} stopOpacity="0.04" />
				</linearGradient>
			</defs>
			<polygon points={area} fill={`url(#${gid})`} />
			<polyline
				points={top}
				fill="none"
				stroke="var(--d2)"
				strokeWidth="1.25"
				strokeLinejoin="miter"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

/** A radial gauge: an arc that fills to `ratio` (0–1) with a prism stroke + a faceted end-cap, and the
 * percentage in the middle. Circular by design so Visitors never reads like the other tiles. */
export function RadialGauge({
	ratio,
	label,
	className,
}: {
	ratio: number;
	label?: string;
	className?: string;
}): ReactElement {
	const gid = useId();
	const r = 26;
	const c = 32;
	const clamped = Math.max(0, Math.min(1, ratio));
	const circ = 2 * Math.PI * r;
	// Leave a 90° gap at the bottom (a gauge, not a full donut); the track spans 270°.
	const arc = 0.75;
	const dash = circ * arc;
	return (
		<svg viewBox="0 0 64 64" className={cn('overflow-visible', className)} aria-hidden="true">
			<defs>
				<linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0%" stopColor={PRISM[0]} />
					<stop offset="50%" stopColor={PRISM[1]} />
					<stop offset="100%" stopColor={PRISM[2]} />
				</linearGradient>
			</defs>
			<g transform={`rotate(135 ${c} ${c})`}>
				<circle
					cx={c}
					cy={c}
					r={r}
					fill="none"
					stroke="rgb(var(--border))"
					strokeWidth="6"
					strokeLinecap="round"
					strokeDasharray={`${dash} ${circ}`}
				/>
				<circle
					cx={c}
					cy={c}
					r={r}
					fill="none"
					stroke={`url(#${gid})`}
					strokeWidth="6"
					strokeLinecap="round"
					strokeDasharray={`${dash * clamped} ${circ}`}
					style={{
						transition: 'stroke-dasharray 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
					}}
				/>
			</g>
			<text
				x={c}
				y={c - 1}
				textAnchor="middle"
				dominantBaseline="central"
				className="tabular fill-[var(--ink)] font-semibold text-[15px]"
			>
				{Math.round(clamped * 100)}%
			</text>
			{label ? (
				<text
					x={c}
					y={c + 13}
					textAnchor="middle"
					dominantBaseline="central"
					className="fill-[var(--faint)] text-[7px] uppercase tracking-[0.1em]"
				>
					{label}
				</text>
			) : null}
		</svg>
	);
}

/** Prism columns: one bar per bucket, height ∝ value, indigo→fuchsia across the series, latest bar
 * white-hot. A bar language (not a line/area) so Events stands apart. */
export function ColumnSpark({
	values,
	className,
}: {
	values: number[];
	className?: string;
}): ReactElement | null {
	const gid = useId();
	if (values.length < 2) return null;
	const max = Math.max(...values, 1);
	const n = values.length;
	const gap = 0.18;
	const bw = 100 / n;
	return (
		<svg
			viewBox="0 0 100 32"
			preserveAspectRatio="none"
			className={cn('overflow-visible', className)}
			aria-hidden="true"
		>
			<defs>
				<linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
					<stop offset="0%" stopColor={PRISM[0]} />
					<stop offset="55%" stopColor={PRISM[1]} />
					<stop offset="100%" stopColor={PRISM[2]} />
				</linearGradient>
			</defs>
			{values.map((v, i) => {
				const bh = Math.max(1, (v / max) * 30);
				const last = i === n - 1;
				return (
					<rect
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length bucket series, index is the identity
						key={i}
						x={i * bw + (bw * gap) / 2}
						y={32 - bh}
						width={bw * (1 - gap)}
						height={bh}
						rx="0.6"
						fill={last ? 'var(--ink)' : `url(#${gid})`}
						opacity={last ? 1 : 0.85}
						style={{
							transition:
								'y 0.45s cubic-bezier(0.22, 1, 0.36, 1), height 0.45s cubic-bezier(0.22, 1, 0.36, 1)',
						}}
					/>
				);
			})}
		</svg>
	);
}
