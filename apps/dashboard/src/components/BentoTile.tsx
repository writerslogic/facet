// Bento primitives for the viewport-filling Overview: a depth-y tile surface (layered shadow, hairline
// ring, gradient-lit face, top highlight) that lifts on hover and can expand to a focused drill-down;
// a count-up hook so metrics animate in "alive"; and a compact KPI readout for a tile.

import type { CountRow } from '@facet/shared';
import { ArrowDown, ArrowUp, Maximize2, TableProperties, X } from 'lucide-react';
import {
	type ReactElement,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from 'react';
import { cn } from '../lib/cn.js';
import { formatNumber } from '../lib/format.js';
import { ColumnSpark, HorizonSpark, RadialGauge } from './KpiViz.js';
import { Sparkline } from './Sparkline.js';
import { TopList } from './TopList.js';

/** The "what drove this metric" breakdown revealed when a KPI tile is expanded — its top contributors,
 * clickable to cross-filter the whole board from inside the drill-down. */
export interface KpiBreakdown {
	title: string;
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
}

/** The compact KPI mini-viz styles a box can switch between (its selectable chart-style variants). */
export type KpiVizName = 'spark' | 'horizon' | 'columns' | 'gauge';

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

// Dark "cut obsidian" surfaces: every tile is inked (.tile-dark supplies the ink face + bevel + prism
// hover edge); emphasis only layers a faint gradient tint so the eye still lands on the hero + flow.
const EMPHASIS: Record<TileEmphasis, string> = {
	hero: 'bg-gradient-to-br from-accent-500/15 via-transparent to-transparent',
	flow: 'bg-gradient-to-br from-white/[0.03] via-transparent to-transparent',
	kpi: 'bg-gradient-to-b from-white/[0.03] to-transparent',
	default: 'bg-gradient-to-b from-white/[0.02] to-transparent',
};

/** A single bento tile. `onExpand` reveals a hover control that focuses the tile in place (the elastic
 * grid inflates it); while focused it shows `onClose` instead. The expand/close buttons carry data hooks
 * so the board can move keyboard focus onto them across the transition. */
export function BentoTile({
	label,
	action,
	onExpand,
	onClose,
	onToggleTable,
	tableActive = false,
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
	/** Toggle the raw-data table view for boxes that expose one. */
	onToggleTable?: () => void;
	tableActive?: boolean;
	focused?: boolean;
	emphasis?: TileEmphasis;
	className?: string;
	bodyClassName?: string;
	children: ReactNode;
}): ReactElement {
	// The whole board is dark now, so every tile carries light header text + controls.
	const dark = true;
	// Expand on a click anywhere in the tile EXCEPT on its own interactive content (list rows cross-filter,
	// flow nodes drill — those must not also expand). The corner Maximize button remains the keyboard path.
	const onTileClick = onExpand
		? (e: ReactMouseEvent<HTMLElement>): void => {
				if (
					!(e.target as HTMLElement).closest(
						'button,a,input,select,textarea,[role="button"],[role="tab"]',
					)
				)
					onExpand();
			}
		: undefined;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: pointer enhancement only; the corner Maximize button is the keyboard-accessible expand control
		<section
			data-focused={focused}
			onClick={onTileClick}
			className={cn(
				'tile-dark facet-glint group relative flex min-h-0 flex-col overflow-hidden rounded-2xl p-4',
				'transition-all duration-300 ease-out',
				focused ? 'z-20' : 'hover:-translate-y-0.5',
				onExpand && 'cursor-pointer',
				EMPHASIS[emphasis],
				className,
			)}
		>
			{/* Controls float as an overlay (not a header row) so a short tile keeps its full height for content. */}
			{onToggleTable ? (
				<button
					type="button"
					onClick={onToggleTable}
					aria-pressed={tableActive}
					aria-label={`${tableActive ? 'Hide' : 'Show'} ${label ?? 'box'} data table`}
					className={cn(
						'absolute right-9 top-2.5 z-20 rounded-md p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 group-hover:opacity-100',
						tableActive
							? 'text-accent-300 opacity-100'
							: 'text-[color:var(--muted)] opacity-40 hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]',
					)}
				>
					<TableProperties className="h-3.5 w-3.5" aria-hidden="true" />
				</button>
			) : null}
			{onClose ? (
				<button
					type="button"
					data-tile-close
					onClick={onClose}
					aria-label={`Close ${label ?? 'tile'} detail`}
					className={cn(
						'absolute right-2.5 top-2.5 z-20 rounded-md p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40',
						dark
							? 'text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]'
							: 'text-[color:var(--muted)] hover:bg-neutral-100 hover:text-neutral-700',
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
						'absolute right-2.5 top-2.5 z-20 rounded-md p-1 opacity-40 transition focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 group-hover:opacity-100',
						dark
							? 'text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]'
							: 'text-[color:var(--muted)] hover:bg-neutral-100 hover:text-neutral-700',
					)}
				>
					<Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
				</button>
			) : null}
			{label || action ? (
				<header className="relative z-10 mb-2 flex shrink-0 items-center justify-between gap-2 pr-7">
					{label ? (
						<h3
							className={cn(
								'text-[11px] font-semibold uppercase tracking-[0.08em]',
								dark ? 'text-[color:var(--muted)]' : 'text-[color:var(--faint)]',
							)}
						>
							{label}
						</h3>
					) : (
						<span />
					)}
					{action ? <div className="flex items-center gap-1.5">{action}</div> : null}
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
			<div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--muted)]">
				{label}
			</div>
			<div className="tabular truncate font-semibold text-[color:var(--ink)] text-sm">
				{value}
			</div>
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
	accent,
	expanded = false,
	breakdown,
	viz = 'spark',
	gaugeRatio,
	gaugeLabel,
}: {
	label: string;
	value: number;
	deltaPct?: number | null;
	deltaSense?: 'improvement' | 'regression' | 'neutral';
	spark?: number[];
	stroke?: string;
	/** The user-chosen data-palette accent; recolours the mini-viz + line + tint. Unset = prism default. */
	accent?: string;
	/** Drill-down layout: a large value over a full area chart, plus an Avg/Peak/Low strip. */
	expanded?: boolean;
	/** Top contributors to this metric, shown beside the chart when expanded (click to cross-filter). */
	breakdown?: KpiBreakdown;
	/** The compact mini-viz, chosen per metric so no two KPI tiles look alike. */
	viz?: KpiVizName;
	/** 0–1 fill for the `gauge` viz (e.g. visitors ÷ pageviews). */
	gaugeRatio?: number;
	gaugeLabel?: string;
}): ReactElement {
	const shown = useCountUp(value);
	const tone =
		deltaSense === 'improvement'
			? 'bg-emerald-50 text-emerald-700 ring-emerald-600/15'
			: deltaSense === 'regression'
				? 'bg-rose-50 text-rose-700 ring-rose-600/15'
				: 'bg-neutral-100 text-[color:var(--faint)] ring-neutral-600/10';
	const hasSpark = Boolean(spark && spark.length > 1);
	const hasBreakdown = Boolean(breakdown && breakdown.rows.length > 0);
	// The accent (when the user picks one) drives the line + tint; otherwise the box's default stroke does.
	const line = accent ?? stroke;
	// color-mix (not a hex-alpha suffix) so the tint works whether `line` is a hex or a palette var().
	const tint = `radial-gradient(120% 80% at 100% 0%, color-mix(in srgb, ${line} 8%, transparent), transparent 60%)`;
	const chip =
		deltaPct != null ? (
			<span
				className={cn(
					'tabular inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1',
					tone,
				)}
			>
				{deltaPct >= 0 ? (
					<ArrowUp className="h-2.5 w-2.5" aria-hidden="true" />
				) : (
					<ArrowDown className="h-2.5 w-2.5" aria-hidden="true" />
				)}
				{Math.abs(deltaPct)}%
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
					<div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--muted)]">
						<span
							className="inline-block size-1.5 rotate-45 rounded-[1px]"
							style={{ background: line }}
							aria-hidden="true"
						/>
						{label}
					</div>
					<div className="mt-1 flex items-baseline gap-2">
						<span className="tabular font-semibold text-4xl text-[color:var(--ink)] leading-none tracking-[-0.02em]">
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
				{hasSpark || hasBreakdown ? (
					<div className="ml-auto flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 py-1">
						{hasSpark ? (
							<div className={hasBreakdown ? 'h-12 shrink-0' : 'min-h-0 flex-1'}>
								<Sparkline
									values={spark as number[]}
									stroke={line}
									fill
									prominent
									marker
									className="h-full w-full"
								/>
							</div>
						) : null}
						{hasBreakdown && breakdown ? (
							<div className="min-h-0 flex-1 overflow-hidden">
								<TopList
									bare
									dark
									limit={5}
									title={breakdown.title}
									rows={breakdown.rows}
									onSelect={breakdown.onSelect}
									activeKey={breakdown.activeKey}
								/>
							</div>
						) : null}
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div className="flex h-full items-center gap-3" style={{ background: tint }}>
			<div className="flex min-w-0 flex-col justify-center">
				<div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--muted)]">
					{label}
				</div>
				<div className="mt-0.5 flex items-baseline gap-1.5">
					<span className="tabular text-[2rem] font-semibold leading-none tracking-[-0.02em] text-[color:var(--ink)] @max-[13rem]/tile:text-3xl @max-[9rem]/tile:text-2xl">
						{formatNumber(Math.round(shown))}
					</span>
					{chip}
				</div>
			</div>
			{viz === 'gauge' ? (
				<div className="ml-auto aspect-square h-full min-h-0 self-stretch py-0.5 @max-[11rem]/tile:hidden">
					<RadialGauge
						ratio={gaugeRatio ?? 0}
						label={gaugeLabel}
						accent={accent}
						className="h-full w-full"
					/>
				</div>
			) : hasSpark ? (
				<div className="ml-auto h-full min-h-0 w-1/2 min-w-0 max-w-[10rem] self-stretch py-1 @max-[11rem]/tile:hidden">
					{viz === 'horizon' ? (
						<HorizonSpark
							values={spark as number[]}
							accent={accent}
							className="h-full w-full"
						/>
					) : viz === 'columns' ? (
						<ColumnSpark
							values={spark as number[]}
							accent={accent}
							className="h-full w-full"
						/>
					) : (
						<Sparkline
							values={spark as number[]}
							stroke={line}
							fill
							marker
							prism={!accent}
							className="h-full w-full"
						/>
					)}
				</div>
			) : null}
		</div>
	);
}
