// Shared building blocks for boxes. `ListBody` is the ranked-list body used by every dimension box
// (pages, referrers, devices, channels, events): compact it is a bare, dark, size-fitting TopList;
// expanded it becomes `ListDetail` — a full, filterable, sortable drill-down over every row.
//
// `ListBody` is a COMPONENT (rendered as <ListBody/>, not called as a function) because it now owns a
// hook: the per-key comparison against the equal-length preceding window. That window is already
// fetched for the Overview's KPI deltas, so every list on the board reads it from the same cache
// entry — see hooks/compare.ts. Boxes that pass no `compare` render exactly as before.

import type { CountRow } from '@facet/shared';
import { Search } from 'lucide-react';
import {
	type ReactElement,
	type ReactNode,
	useDeferredValue,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from 'react';
import { type CompareSource, useBreakdownComparison } from '../../hooks/compare.js';
import { cn } from '../../lib/cn.js';
import type { DroppedRow } from '../../lib/compare.js';
import { type Movement, formatNumber } from '../../lib/format.js';
import { DroppedRows } from '../CompareList.js';
import { DeltaBadge } from '../Delta.js';
import { InspectButton, TopList, hueForTitle } from '../TopList.js';
import { ChartEmpty } from '../charts/ChartChrome.js';
import { DrillPanel, type DrillSpec, type DrillState, undrillableNote, useDrill } from './drill.js';
import type { TableData, TileConfig, TileOption, TileVariant } from './types.js';

/** A shared "Color" option: pick one of the active palette's data colours for a box; boxes apply it to
 * their chart stroke + surface tint. Palette tokens resolve per theme, so a box stays on-palette. */
export const ACCENT_OPTION: TileOption = {
	key: 'accent',
	label: 'Color',
	type: 'color',
	choices: [
		{ value: 'auto', label: 'Auto (prism)' },
		{ value: 'var(--d1)', label: 'Indigo' },
		{ value: 'var(--d2)', label: 'Violet' },
		{ value: 'var(--d3)', label: 'Fuchsia' },
		{ value: 'var(--c4)', label: 'Cyan' },
		{ value: 'var(--c5)', label: 'Amber' },
		{ value: 'var(--pos)', label: 'Green' },
	],
	default: 'auto',
};

/** The explicit accent colour chosen for a box, or `undefined` for "auto" (keep the box's prism default).
 * A box passes this straight to a viz's `accent` prop — undefined means "use the built-in ramp". */
export function accentOf(config: TileConfig | undefined): string | undefined {
	const v = config?.accent;
	return typeof v === 'string' && v !== 'auto' ? v : undefined;
}

/** A ranked-list box's data as a table: name, count, and share-of-total percent. */
export function rowsTable(nameCol: string, rows: CountRow[]): TableData {
	const total = rows.reduce((s, r) => s + r.count, 0);
	return {
		columns: [nameCol, 'Count', 'Share %'],
		rows: rows.map((r) => [
			r.key,
			r.count,
			total > 0 ? Math.round((r.count / total) * 100) : 0,
		]),
	};
}

/** The chart styles a dimension list can wear (declared by every list box). */
export const LIST_VARIANTS: TileVariant[] = [
	{ id: 'bars', label: 'Bars' },
	{ id: 'donut', label: 'Donut' },
	{ id: 'table', label: 'Table' },
];

/** The customization options a dimension list exposes: how many rows to show, and an accent colour. */
export const LIST_OPTIONS: TileOption[] = [
	{
		key: 'rows',
		label: 'Rows',
		type: 'select',
		choices: [
			{ value: 'auto', label: 'Auto' },
			{ value: '5', label: 'Top 5' },
			{ value: '8', label: 'Top 8' },
			{ value: '12', label: 'Top 12' },
		],
		default: 'auto',
	},
	ACCENT_OPTION,
];

/** The row cap chosen for a list, or `undefined` for "auto" (height-fit bars, sensible default elsewhere). */
function rowLimitOf(config: TileConfig | undefined): number | undefined {
	const v = config?.rows;
	if (typeof v !== 'string' || v === 'auto') return undefined;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : undefined;
}

export function ListBody({
	title,
	rows,
	onSelect,
	activeKey,
	expanded,
	config,
	compare,
	drill: spec,
	noun,
}: {
	title: string;
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	expanded?: boolean;
	config?: TileConfig;
	/** The same list over the equal-length preceding window. Omitted ⇒ no deltas anywhere in this box. */
	compare?: CompareSource | null;
	/** Enables in-tile drill-down: each row can reveal its own composition. A spec whose `axis` is null
	 * declares the dimension undrillable and explains why instead of offering a control. Omitted
	 * entirely ⇒ the list behaves exactly as it did before drill-down existed. */
	drill?: DrillSpec;
	/** Singular noun for a row of this list ("page", "browser"), used in the undrillable note. */
	noun?: string;
}): ReactElement {
	const { movements, dropped } = useBreakdownComparison(compare);
	const drill = useDrill(spec);
	const panelId = useId();
	const limit = rowLimitOf(config);
	const accent = accentOf(config);
	// The panel wears the list's own colour: an explicit accent when the user picked one, else the
	// dimension hue TopList would have drawn its bars in.
	const hue = accent ?? hueForTitle(title);
	// A list whose dimension the API cannot filter says so — but only where there is room to read it.
	const note = spec && !spec.axis && noun ? undrillableNote(noun) : undefined;
	const inspect = drill.enabled
		? {
				onInspect: drill.inspect,
				inspectedKey: drill.rowKey,
				inspectControls: panelId,
			}
		: {};

	const list = expanded ? (
		<ListDetail
			title={title}
			rows={rows}
			onSelect={onSelect}
			activeKey={activeKey}
			deltas={movements}
			dropped={dropped}
			note={note}
			inspect={inspect}
		/>
	) : config?.variant === 'donut' ? (
		<DonutList
			rows={rows}
			onSelect={onSelect}
			activeKey={activeKey}
			accent={accent}
			limit={limit ?? 5}
			deltas={movements}
			inspect={drill.enabled ? drill : undefined}
			panelId={panelId}
		/>
	) : config?.variant === 'table' ? (
		<MiniTable
			title={title}
			rows={rows}
			activeKey={activeKey}
			limit={limit}
			deltas={movements}
		/>
	) : (
		// Default 'bars': the ranked TopList. With no explicit cap it height-fits; a cap disables fit.
		<TopList
			bare
			dark
			fit={limit === undefined}
			limit={limit ?? 6}
			title={title}
			rows={rows}
			onSelect={onSelect}
			activeKey={activeKey}
			accent={accent}
			deltas={movements}
			{...inspect}
		/>
	);

	if (!drill.enabled) return list;
	return (
		<DrillFrame
			drill={drill}
			spec={spec as DrillSpec}
			title={title}
			hue={hue}
			expanded={Boolean(expanded)}
			panelId={panelId}
		>
			{list}
		</DrillFrame>
	);
}

/**
 * Hosts a list and its drill panel.
 *
 * Progressive disclosure, sized honestly: a COMPACT tile has no room for both, so the panel takes the
 * body and the breadcrumb is the way back — the list is one click away and the tile never grows. An
 * EXPANDED tile is where the reader is investigating, so the list stays put and the panel opens beside
 * it (below it on a narrow expansion), keeping the row you came from in view.
 */
function DrillFrame({
	drill,
	spec,
	title,
	hue,
	expanded,
	panelId,
	children,
}: {
	drill: DrillState;
	spec: DrillSpec;
	title: string;
	hue: string;
	expanded: boolean;
	panelId: string;
	children: ReactElement;
}): ReactElement {
	const hostRef = useRef<HTMLDivElement>(null);
	// The row whose panel is open, remembered across the close so focus can go back to its control.
	const cameFrom = useRef<string | undefined>(undefined);
	const wasOpen = useRef(false);

	// Keyboard continuity. On a COMPACT tile the panel replaces the list, so the inspect control that
	// was just activated is unmounted and the browser drops focus on <body> — the reader loses their
	// place in the tab order entirely. Move focus onto the panel's Close on open, and back onto the row
	// it came from on close (the same handoff BentoBoard performs when a tile expands). An EXPANDED
	// tile keeps the list mounted, so nothing is lost and nothing is moved.
	useEffect(() => {
		const host = hostRef.current;
		if (!host || expanded) {
			wasOpen.current = drill.open;
			return;
		}
		if (drill.open && !wasOpen.current) {
			cameFrom.current = drill.rowKey;
			host.querySelector<HTMLElement>('[data-drill-focus]')?.focus();
		} else if (!drill.open && wasOpen.current && cameFrom.current !== undefined) {
			const row = host.querySelector<HTMLElement>(
				`[data-inspect-key="${CSS.escape(cameFrom.current)}"]`,
			);
			// A data refresh while the panel was open can remove the inspected row before close — fall
			// back to the list container (tabIndex below) so focus lands somewhere in the tile instead
			// of silently staying nowhere as the closing panel's Close button unmounts under it.
			(row ?? host).focus();
		}
		wasOpen.current = drill.open;
	}, [drill.open, drill.rowKey, expanded]);

	const panel = (
		<DrillPanel
			id={panelId}
			spec={spec}
			drill={drill}
			title={title}
			hue={hue}
			expanded={expanded}
		/>
	);
	return (
		<div
			ref={hostRef}
			// Not in the tab order (reachable only via focus() above) — a fallback target for when the
			// row the panel closed back to no longer exists in the DOM.
			tabIndex={-1}
			className="flex h-full min-h-0 flex-col"
		>
			{/* Drill transitions are a state change with no focus move, so they need announcing. */}
			<output data-chrome className="sr-only" aria-live="polite">
				{drill.announcement}
			</output>
			{!drill.open ? (
				<div className="min-h-0 flex-1">{children}</div>
			) : expanded ? (
				<div className="grid min-h-0 flex-1 grid-rows-2 gap-3 @[34rem]/tile:grid-cols-2 @[34rem]/tile:grid-rows-1">
					<div className="min-h-0 overflow-hidden">{children}</div>
					<div className="min-h-0">{panel}</div>
				</div>
			) : (
				<div className="min-h-0 flex-1">{panel}</div>
			)}
		</div>
	);
}

/** Slice palette for the donut when no accent is chosen — the prism data hues, cycled. */
const SLICE_COLORS = [
	'var(--c1)',
	'var(--c2)',
	'var(--c3)',
	'var(--d1)',
	'var(--d2)',
	'var(--d3)',
] as const;

/** A donut of the top slices (plus an aggregated "Other"), with a clickable legend that cross-filters.
 * Accent-tinted when a colour is chosen, else prism-cycled. Legend hides on a narrow tile (donut stays). */
function DonutList({
	rows,
	onSelect,
	activeKey,
	accent,
	limit,
	deltas,
	inspect,
	panelId,
}: {
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	accent?: string;
	limit: number;
	deltas?: ReadonlyMap<string, Movement>;
	/** Drill state, when this list's dimension is drillable — the legend grows an inspect control. */
	inspect?: DrillState;
	panelId?: string;
}): ReactElement {
	const total = rows.reduce((sum, r) => sum + r.count, 0);
	const top = rows.slice(0, limit);
	const otherCount = total - top.reduce((sum, r) => sum + r.count, 0);
	const slices = otherCount > 0 ? [...top, { key: 'Other', count: otherCount }] : top;
	const color = (i: number): string =>
		accent
			? `color-mix(in srgb, ${accent} ${Math.max(28, 100 - i * 16)}%, transparent)`
			: (SLICE_COLORS[i % SLICE_COLORS.length] ?? 'var(--c1)');
	if (total === 0) {
		return <ChartEmpty reason="range" compact />;
	}
	let acc = 0;
	return (
		<div className="flex h-full items-center gap-3">
			<div className="relative aspect-square h-full max-h-[9rem] min-h-0 shrink-0">
				<svg viewBox="0 0 42 42" className="-rotate-90 h-full w-full" aria-hidden="true">
					<circle
						cx="21"
						cy="21"
						r="15.915"
						fill="none"
						stroke="rgb(var(--hover))"
						strokeWidth="4.5"
					/>
					{slices.map((s, i) => {
						const pct = (s.count / total) * 100;
						const seg = (
							<circle
								key={s.key}
								cx="21"
								cy="21"
								r="15.915"
								fill="none"
								stroke={color(i)}
								strokeWidth="4.5"
								strokeDasharray={`${pct} ${100 - pct}`}
								strokeDashoffset={`${-acc}`}
								style={{
									transition:
										'stroke-dasharray 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
								}}
							/>
						);
						acc += pct;
						return seg;
					})}
				</svg>
				<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
					<span className="tabular font-semibold text-[color:var(--ink)] text-sm">
						{formatNumber(total)}
					</span>
					<span className="text-[9px] text-[color:var(--muted)] uppercase tracking-wide">
						total
					</span>
				</div>
			</div>
			<ul className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 @max-[13rem]/tile:hidden">
				{slices.map((s, i) => {
					const active = s.key === activeKey;
					const pct = Math.round((s.count / total) * 100);
					const clickable = Boolean(onSelect) && s.key !== 'Other';
					const inner = (
						<>
							<span
								className="size-2 shrink-0 rounded-[2px]"
								style={{ background: color(i) }}
								aria-hidden="true"
							/>
							<span
								className={cn(
									'min-w-0 truncate font-medium',
									active
										? 'text-[color:var(--chip-ink)]'
										: 'text-[color:var(--ink)]',
								)}
								title={s.key}
							>
								{s.key}
							</span>
							<span className="ml-auto shrink-0 text-[color:var(--muted)] tabular-nums">
								{pct}%
							</span>
							{/* "Other" is an aggregate of whatever fell outside the top slices, so
							    its membership differs between periods — never compared. */}
							{s.key === 'Other' ? null : (
								<DeltaBadge
									movement={deltas?.get(s.key)}
									variant="text"
									size="sm"
									className="shrink-0"
								/>
							)}
						</>
					);
					const cls =
						'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px]';
					const body = clickable ? (
						<button
							type="button"
							aria-pressed={active}
							onClick={() => onSelect?.(s.key)}
							className={cn(
								cls,
								'transition-colors hover:bg-[color:rgb(var(--hover))]',
								active && 'bg-[color:rgb(var(--hover))]',
							)}
						>
							{inner}
						</button>
					) : (
						<div className={cls}>{inner}</div>
					);
					// "Other" is a bucket, not a value: no filter names it, so it cannot be composed.
					if (!inspect || s.key === 'Other') return <li key={s.key}>{body}</li>;
					return (
						<li key={s.key} className="group/row flex items-stretch gap-0.5">
							<div className="min-w-0 flex-1">{body}</div>
							<InspectButton
								rowKey={s.key}
								open={inspect.rowKey === s.key}
								controls={panelId}
								onClick={() => inspect.inspect(s.key)}
							/>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/** A compact ranked table (key / count / share) for reading the raw numbers in place — a denser encoding
 * than the bars. Read-only; cross-filter lives on the bar + donut styles. */
function MiniTable({
	title,
	rows,
	activeKey,
	limit,
	deltas,
}: {
	title: string;
	rows: CountRow[];
	activeKey?: string;
	limit?: number;
	deltas?: ReadonlyMap<string, Movement>;
}): ReactElement {
	const total = rows.reduce((sum, r) => sum + r.count, 0);
	const shown = limit ? rows.slice(0, limit) : rows;
	if (shown.length === 0) {
		return <ChartEmpty reason="range" compact />;
	}
	return (
		<div className="h-full overflow-auto">
			<table className="w-full text-[13px]">
				<thead className="sticky top-0 bg-[var(--panel)]">
					<tr className="text-[10px] text-[color:var(--muted)] uppercase tracking-wide">
						<th className="py-1 pr-2 text-left font-semibold">{title}</th>
						<th className="px-2 py-1 text-right font-semibold">Count</th>
						<th className="py-1 pl-2 text-right font-semibold">%</th>
					</tr>
				</thead>
				<tbody>
					{shown.map((r) => {
						const active = r.key === activeKey;
						const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
						return (
							<tr
								key={r.key}
								className={cn(
									'border-[color:rgb(var(--border))] border-t',
									active
										? 'text-[color:var(--chip-ink)]'
										: 'text-[color:var(--ink)]',
								)}
							>
								<td className="max-w-0 truncate py-1 pr-2" title={r.key}>
									{r.key}
								</td>
								<td className="px-2 py-1 text-right font-semibold tabular-nums">
									<span className="inline-flex items-baseline gap-1">
										{formatNumber(r.count)}
										<DeltaBadge
											movement={deltas?.get(r.key)}
											variant="text"
											size="sm"
										/>
									</span>
								</td>
								<td className="py-1 pl-2 text-right text-[color:var(--muted)] tabular-nums">
									{pct}%
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/** One summary figure in a list drill-down's header (total / distinct / top share). */
function DetailMetric({
	label,
	value,
}: {
	label: string;
	value: string;
}): ReactNode {
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

/** The expanded drill-down for a dimension list: a summary strip (total, distinct keys, the leader's
 * share), a live substring filter, a Top ↔ A–Z sort toggle, and the FULL ranked list (scrolling), with
 * cross-filter clicks preserved. The header controls collapse away on a narrow tile so it stays legible
 * at any size. */
function ListDetail({
	title,
	rows,
	onSelect,
	activeKey,
	deltas,
	dropped,
	note,
	inspect,
}: {
	title: string;
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	deltas?: ReadonlyMap<string, Movement>;
	dropped?: readonly DroppedRow[];
	/** Why this list offers no drill-down. Shown only here: a compact tile has no room to read it, and
	 * a limitation stated where it cannot be read is not stated at all. */
	note?: string;
	/** Row inspect wiring, spread onto the list. */
	inspect?: {
		onInspect?: (key: string) => void;
		inspectedKey?: string;
		inspectControls?: string;
	};
}): ReactElement {
	const [query, setQuery] = useState('');
	const [alpha, setAlpha] = useState(false);
	const deferredQuery = useDeferredValue(query);
	const total = rows.reduce((sum, r) => sum + r.count, 0);
	const view = useMemo(() => {
		const q = deferredQuery.trim().toLowerCase();
		const filtered = q ? rows.filter((r) => r.key.toLowerCase().includes(q)) : rows;
		return alpha ? [...filtered].sort((a, b) => a.key.localeCompare(b.key)) : filtered;
	}, [rows, deferredQuery, alpha]);
	const leader = rows[0];
	const topShare = total > 0 && leader ? Math.round((leader.count / total) * 100) : 0;
	return (
		<div className="flex h-full flex-col gap-3">
			<div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2">
				<DetailMetric label="Total" value={formatNumber(total)} />
				<DetailMetric label="Distinct" value={formatNumber(rows.length)} />
				{leader ? (
					<DetailMetric label={`Top · ${leader.key}`} value={`${topShare}%`} />
				) : null}
				<div className="ml-auto flex items-center gap-2">
					<label className="relative flex items-center @max-[24rem]/tile:hidden">
						<Search
							className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[color:var(--faint)]"
							aria-hidden="true"
						/>
						<input
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Filter"
							aria-label={`Filter ${title}`}
							className="w-40 rounded-lg border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] py-1 pr-2 pl-7 text-sm text-[color:var(--ink)] placeholder:text-[color:var(--faint)] focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
						/>
					</label>
					<button
						type="button"
						onClick={() => setAlpha((v) => !v)}
						aria-pressed={alpha}
						aria-label={`Sort ${alpha ? 'by count' : 'alphabetically'}`}
						className="shrink-0 rounded-lg border border-[color:rgb(var(--border))] px-2 py-1 text-[11px] font-medium text-[color:var(--muted)] transition hover:text-[color:var(--ink)]"
					>
						{alpha ? 'A–Z' : 'Top'}
					</button>
				</div>
			</div>
			{note ? (
				<p className="shrink-0 text-[11px] text-[color:var(--muted)] leading-snug">
					{note}
				</p>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{view.length === 0 ? (
					<p className="py-6 text-center text-sm text-[color:var(--muted)]">No matches</p>
				) : (
					<TopList
						bare
						dark
						title={title}
						rows={view}
						onSelect={onSelect}
						activeKey={activeKey}
						deltas={deltas}
						{...inspect}
						// Only in the drill-down: a compact tile is height-fitted, and a key that
						// LEFT the list still deserves to be seen rather than silently missing.
						// Suppressed while filtering/sorting, where the list is no longer the list
						// those keys dropped out of.
						trailing={
							dropped && dropped.length > 0 && view.length === rows.length ? (
								<DroppedRows rows={dropped} />
							) : null
						}
					/>
				)}
			</div>
		</div>
	);
}
