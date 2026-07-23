// Bento primitives for the viewport-filling Overview: a depth-y tile surface (layered shadow, hairline
// ring, gradient-lit face, top highlight) that lifts on hover and can expand to a focused drill-down;
// a count-up hook so metrics animate in "alive"; and a compact KPI readout for a tile.

import { Maximize2 } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { formatNumber } from '../lib/format.js';
import { Sparkline } from './Sparkline.js';

/** Ease-out count-up to `value`. Respects prefers-reduced-motion (jumps straight to the value). */
export function useCountUp(value: number, ms = 650): number {
	const [n, setN] = useState(value);
	const fromRef = useRef(value);
	useEffect(() => {
		if (
			typeof matchMedia !== 'undefined' &&
			matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			setN(value);
			return;
		}
		const from = fromRef.current;
		const start = performance.now();
		let raf = 0;
		const tick = (t: number): void => {
			const p = Math.min(1, (t - start) / ms);
			const eased = 1 - (1 - p) ** 3;
			setN(from + (value - from) * eased);
			if (p < 1) raf = requestAnimationFrame(tick);
			else fromRef.current = value;
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [value, ms]);
	return n;
}

/** A single bento tile. `onExpand` reveals a hover control to drill into the tile's detail. */
export function BentoTile({
	label,
	action,
	onExpand,
	className,
	bodyClassName,
	children,
}: {
	label?: string;
	action?: ReactNode;
	onExpand?: () => void;
	className?: string;
	bodyClassName?: string;
	children: ReactNode;
}): ReactElement {
	return (
		<section
			className={cn(
				'group relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-neutral-200/70 bg-white p-4',
				'shadow-card ring-1 ring-neutral-900/5 transition-all duration-300 ease-out',
				'hover:-translate-y-0.5 hover:shadow-float',
				// gradient-lit face + a faint top highlight for depth
				'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/80 before:to-transparent',
				className,
			)}
		>
			{label || action || onExpand ? (
				<header className="relative z-10 mb-2 flex shrink-0 items-center justify-between gap-2">
					{label ? (
						<h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
							{label}
						</h3>
					) : (
						<span />
					)}
					<div className="flex items-center gap-1.5">
						{action}
						{onExpand ? (
							<button
								type="button"
								onClick={onExpand}
								aria-label={`Expand ${label ?? 'tile'}`}
								className="rounded-md p-1 text-neutral-300 opacity-0 transition hover:bg-neutral-100 hover:text-neutral-600 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 group-hover:opacity-100"
							>
								<Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
							</button>
						) : null}
					</div>
				</header>
			) : null}
			<div className={cn('relative z-10 min-h-0 flex-1', bodyClassName)}>{children}</div>
		</section>
	);
}

/** Compact metric readout for a KPI tile: an animated count-up value, a delta chip, and a sparkline
 * that fills the tile's remaining height. Stroke tints the whole tile toward the metric's colour. */
export function KpiTile({
	label,
	value,
	deltaPct,
	deltaSense,
	spark,
	stroke = '#6366f1',
}: {
	label: string;
	value: number;
	deltaPct?: number | null;
	deltaSense?: 'improvement' | 'regression' | 'neutral';
	spark?: number[];
	stroke?: string;
}): ReactElement {
	const shown = useCountUp(value);
	const tone =
		deltaSense === 'improvement'
			? 'bg-emerald-50 text-emerald-700 ring-emerald-600/15'
			: deltaSense === 'regression'
				? 'bg-rose-50 text-rose-700 ring-rose-600/15'
				: 'bg-neutral-100 text-neutral-500 ring-neutral-600/10';
	return (
		<div className="flex h-full flex-col justify-between">
			<div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
				{label}
			</div>
			<div className="mt-1 flex items-end justify-between gap-2">
				<span className="tabular text-4xl font-semibold leading-none tracking-[-0.02em] text-neutral-900">
					{formatNumber(Math.round(shown))}
				</span>
				{deltaPct != null ? (
					<span
						className={cn(
							'tabular mb-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1',
							tone,
						)}
					>
						{deltaPct >= 0 ? '+' : ''}
						{deltaPct}%
					</span>
				) : null}
			</div>
			{spark && spark.length > 1 ? (
				<div className="mt-2 min-h-0 flex-1">
					<Sparkline values={spark} stroke={stroke} fill className="h-full w-full" />
				</div>
			) : null}
		</div>
	);
}
