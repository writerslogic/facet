// Bento primitives for the viewport-filling Overview: a depth-y tile surface (layered shadow, hairline
// ring, gradient-lit face, top highlight) that lifts on hover and can expand to a focused drill-down;
// a count-up hook so metrics animate in "alive"; and a compact KPI readout for a tile.

import { Maximize2, X } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { formatNumber } from '../lib/format.js';
import { Sparkline } from './Sparkline.js';

/** Ease-out count-up to `value`. Respects prefers-reduced-motion (jumps straight to the value). The
 * origin ref tracks the live displayed value every frame, so an animation interrupted mid-flight (the
 * common case under cross-filtering) resumes from where it visually is rather than rewinding. */
export function useCountUp(value: number, ms = 650): number {
	const [n, setN] = useState(value);
	const fromRef = useRef(value);
	useEffect(() => {
		if (
			typeof matchMedia !== 'undefined' &&
			matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			fromRef.current = value;
			setN(value);
			return;
		}
		const from = fromRef.current;
		const start = performance.now();
		let raf = 0;
		const tick = (t: number): void => {
			const p = Math.min(1, (t - start) / ms);
			const eased = 1 - (1 - p) ** 3;
			const cur = from + (value - from) * eased;
			fromRef.current = cur;
			setN(cur);
			if (p < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [value, ms]);
	return n;
}

/** Surface emphasis: `hero` gets an accent-tinted face + ring so the eye lands on it first; `flow` is the
 * dark feature surface (inked, so the flow's light ribbons pop); `kpi` a lighter lift; default is the
 * plain lit face. */
export type TileEmphasis = 'hero' | 'flow' | 'kpi' | 'default';

const EMPHASIS: Record<TileEmphasis, string> = {
	hero: 'bg-gradient-to-br from-accent-50/50 via-white to-white ring-accent-500/10',
	flow: 'border-white/10 bg-gradient-to-br from-neutral-900 via-neutral-900 to-neutral-800 text-neutral-100 ring-white/10',
	kpi: 'bg-gradient-to-b from-white to-neutral-50/70 ring-neutral-900/5',
	default: 'bg-gradient-to-b from-white to-neutral-50/60 ring-neutral-900/5',
};

/** A single bento tile. `onExpand` reveals a hover control that focuses the tile in place (the elastic
 * grid inflates it); while focused it shows `onClose` instead. The expand/close buttons carry data hooks
 * so the board can move keyboard focus onto them across the transition. */
export function BentoTile({
	label,
	action,
	onExpand,
	onClose,
	focused = false,
	emphasis = 'default',
	className,
	bodyClassName,
	children,
}: {
	label?: string;
	action?: ReactNode;
	onExpand?: () => void;
	onClose?: () => void;
	focused?: boolean;
	emphasis?: TileEmphasis;
	className?: string;
	bodyClassName?: string;
	children: ReactNode;
}): ReactElement {
	// A dark surface (the flow tile) needs light header text + controls to stay visible.
	const dark = emphasis === 'flow';
	return (
		<section
			className={cn(
				'group relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-neutral-200/70 p-4',
				'shadow-card ring-1 transition-all duration-300 ease-out',
				focused
					? 'z-20 shadow-float ring-2 ring-accent-500/30'
					: 'hover:-translate-y-0.5 hover:shadow-float',
				// gradient-lit face + a faint top highlight for depth
				'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/80 before:to-transparent',
				EMPHASIS[emphasis],
				className,
			)}
		>
			{label || action || onExpand || onClose ? (
				<header className="relative z-10 mb-2 flex shrink-0 items-center justify-between gap-2">
					{label ? (
						<h3
							className={cn(
								'text-[11px] font-semibold uppercase tracking-[0.08em]',
								dark ? 'text-neutral-400' : 'text-neutral-500',
							)}
						>
							{label}
						</h3>
					) : (
						<span />
					)}
					<div className="flex items-center gap-1.5">
						{action}
						{onClose ? (
							<button
								type="button"
								data-tile-close
								onClick={onClose}
								aria-label={`Close ${label ?? 'tile'} detail`}
								className={cn(
									'rounded-md p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40',
									dark
										? 'text-neutral-300 hover:bg-white/10 hover:text-white'
										: 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700',
								)}
							>
								<X className="h-3.5 w-3.5" aria-hidden="true" />
							</button>
						) : onExpand ? (
							<button
								type="button"
								data-tile-expand
								onClick={onExpand}
								aria-label={`Expand ${label ?? 'tile'}`}
								// Faintly visible at rest so every tile signals it can be expanded; solid on hover/focus.
								className={cn(
									'rounded-md p-1 opacity-40 transition focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 group-hover:opacity-100',
									dark
										? 'text-neutral-300 hover:bg-white/10 hover:text-white'
										: 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700',
								)}
							>
								<Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
							</button>
						) : null}
					</div>
				</header>
			) : null}
			<div className={cn('@container/tile relative z-10 min-h-0 flex-1', bodyClassName)}>
				{children}
			</div>
		</section>
	);
}

/** One label/value cell in the expanded KPI's stat strip. */
function KpiStat({
	label,
	value,
}: {
	label: string;
	value: string;
}): ReactElement {
	return (
		<div className="min-w-0">
			<div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
				{label}
			</div>
			<div className="tabular truncate font-semibold text-neutral-800 text-sm">{value}</div>
		</div>
	);
}

export function KpiTile({
	label,
	value,
	deltaPct,
	deltaSense,
	spark,
	stroke = '#6366f1',
	expanded = false,
}: {
	label: string;
	value: number;
	deltaPct?: number | null;
	deltaSense?: 'improvement' | 'regression' | 'neutral';
	spark?: number[];
	stroke?: string;
	/** Drill-down layout: a large value over a full area chart, plus an Avg/Peak/Low strip. */
	expanded?: boolean;
}): ReactElement {
	const shown = useCountUp(value);
	const tone =
		deltaSense === 'improvement'
			? 'bg-emerald-50 text-emerald-700 ring-emerald-600/15'
			: deltaSense === 'regression'
				? 'bg-rose-50 text-rose-700 ring-rose-600/15'
				: 'bg-neutral-100 text-neutral-500 ring-neutral-600/10';
	const hasSpark = Boolean(spark && spark.length > 1);
	const tint = `radial-gradient(120% 80% at 100% 0%, ${stroke}14, transparent 60%)`;
	const chip =
		deltaPct != null ? (
			<span
				className={cn(
					'tabular inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1',
					tone,
				)}
			>
				{deltaPct >= 0 ? '+' : ''}
				{deltaPct}%
			</span>
		) : null;

	if (expanded) {
		const s = spark;
		const stats =
			s && s.length > 1
				? {
						avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
						peak: Math.max(...s),
						low: Math.min(...s),
					}
				: null;
		// A focused KPI is wide but short (it spans one grid row), so lay it out horizontally: the metric
		// and its Avg/Peak/Low read on the left while a large area chart fills the full height on the right.
		return (
			<div className="flex h-full items-stretch gap-5" style={{ background: tint }}>
				<div className="flex min-w-0 flex-col justify-center">
					<div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
						{label}
					</div>
					<div className="mt-1 flex items-baseline gap-2">
						<span className="tabular font-semibold text-4xl text-neutral-900 leading-none tracking-[-0.02em]">
							{formatNumber(Math.round(shown))}
						</span>
						{chip}
					</div>
					{stats ? (
						<div className="mt-4 flex gap-5">
							<KpiStat label="Avg" value={formatNumber(stats.avg)} />
							<KpiStat label="Peak" value={formatNumber(stats.peak)} />
							<KpiStat label="Low" value={formatNumber(stats.low)} />
						</div>
					) : null}
				</div>
				{hasSpark ? (
					<div className="ml-auto h-full min-h-0 min-w-0 flex-1 py-1">
						<Sparkline
							values={spark as number[]}
							stroke={stroke}
							fill
							prominent
							className="h-full w-full"
						/>
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div className="flex h-full items-center gap-3" style={{ background: tint }}>
			<div className="flex min-w-0 flex-col justify-center">
				<div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
					{label}
				</div>
				<div className="mt-0.5 flex items-baseline gap-1.5">
					<span className="tabular text-[2rem] font-semibold leading-none tracking-[-0.02em] text-neutral-900 @max-[13rem]/tile:text-3xl @max-[9rem]/tile:text-2xl">
						{formatNumber(Math.round(shown))}
					</span>
					{chip}
				</div>
			</div>
			{hasSpark ? (
				<div className="ml-auto h-full min-h-0 w-1/2 min-w-0 max-w-[10rem] self-stretch py-1 @max-[11rem]/tile:hidden">
					<Sparkline
						values={spark as number[]}
						stroke={stroke}
						fill
						className="h-full w-full"
					/>
				</div>
			) : null}
		</div>
	);
}
