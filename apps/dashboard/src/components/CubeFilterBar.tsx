// The active-segment surfaces. Three exports, one shared chip:
//
//   • `CubeFilterBar`  — the Overview bar: device/country/channel selects (instant client slices)
//                        plus the chips. Path/referrer are set by clicking a breakdown row.
//   • `SegmentBar`     — the compact companion shown on every OTHER tab, so a segment stays visible
//                        and clearable wherever the investigation goes. Same chips, no selects: the
//                        selects are built from the Overview's in-memory cube, which other tabs
//                        don't hydrate.
//   • `SegmentNotice`  — what this tab can actually DO with the segment. Rendered by each tab next
//                        to its own numbers, worded from the single table in lib/segment.ts.
//
// The bars are one component's two densities rather than two implementations, because the failure
// mode of duplicating them is a chip that clears the filter on one tab and not on another.

import type { CubeCell } from '@facet/shared';
import { X } from 'lucide-react';
import type { ReactElement } from 'react';
import { useSegment } from '../hooks/segment.js';
import { cn } from '../lib/cn.js';
import { cubeDimensions } from '../lib/cube.js';
import {
	CUBE_KEYS,
	SEGMENT_LABELS,
	type SegmentKey,
	type SegmentTab,
	TAB_SEGMENT_SUPPORT,
	segmentEntries,
} from '../lib/segment.js';

function Chip({
	label,
	value,
	onRemove,
}: {
	label: string;
	value: string;
	onRemove: () => void;
}): ReactElement {
	return (
		<button
			type="button"
			onClick={onRemove}
			className={cn(
				'inline-flex max-w-[22ch] items-center gap-1 rounded-full chip-active px-2 py-0.5 text-xs font-medium',
				'transition hover:brightness-110',
			)}
			title={`Remove ${label} filter`}
		>
			{/* The dimension name is UI furniture; the value is the reader's own data and must stay
			    inside a Cmd+A selection. The label used to carry a hardcoded accent-500. */}
			<span data-chrome className="opacity-70">
				{label}:
			</span>
			<span data-selectable className="truncate">
				{value}
			</span>
			<X className="h-3 w-3 shrink-0" aria-hidden="true" />
		</button>
	);
}

/** The removable chips for every active dimension plus one "Clear all". Null when nothing is set. */
function SegmentChips(): ReactElement | null {
	const { segment, active, remove, clear } = useSegment();
	if (!active) return null;
	return (
		<span className="flex shrink-0 flex-nowrap items-center gap-1.5">
			{segmentEntries(segment).map((entry) => (
				<Chip
					key={entry.key}
					label={entry.label}
					value={entry.value}
					onRemove={() => remove(entry.key)}
				/>
			))}
			<button
				type="button"
				data-chrome
				onClick={clear}
				className="text-xs font-medium text-[color:var(--muted)] underline hover:text-[color:var(--ink)]"
			>
				Clear all
			</button>
		</span>
	);
}

export function CubeFilterBar({ cells }: { cells: CubeCell[] }): ReactElement | null {
	const { segment, active, toggle, remove } = useSegment();
	if (cells.length === 0 && !active) return null;
	const dims = cubeDimensions(cells);

	return (
		// Single fixed-height row (no wrap, horizontal scroll on overflow) so toggling a filter never
		// changes the bar's height — otherwise the elastic board below reflows and every tile jumps.
		<div className="flex flex-nowrap items-center gap-x-4 overflow-x-auto rounded-xl border border-[color:rgb(var(--border))] bg-[var(--panel)]/[0.03] px-3.5 py-1.5 text-sm shadow-card ring-1 ring-white/5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
			<span
				data-chrome
				className="shrink-0 text-[13px] font-medium text-[color:var(--muted)]"
			>
				Slice
			</span>
			{cells.length > 0
				? CUBE_KEYS.map((key) => (
						<label key={key} className="flex shrink-0 items-center gap-1.5">
							<span className="text-xs text-[color:var(--muted)]">
								{SEGMENT_LABELS[key]}
							</span>
							<select
								value={segment[key] ?? ''}
								onChange={(e) =>
									e.target.value
										? toggle(key as SegmentKey, e.target.value)
										: remove(key as SegmentKey)
								}
								className="rounded-lg border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] px-2 py-1 text-sm text-[color:var(--ink)] focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400 [&>option]:text-[color:var(--ink)]"
							>
								<option value="">All</option>
								{dims[key].map((v) => (
									<option key={v} value={v}>
										{v}
									</option>
								))}
							</select>
						</label>
					))
				: null}
			<span className="ml-auto flex shrink-0 items-center">
				<SegmentChips />
			</span>
		</div>
	);
}

/**
 * The persistent, global indicator. Rendered above every non-Overview tab so the segment you set on
 * the Overview is visible — and removable — wherever the investigation went next. Null when no
 * segment is active, so an unfiltered dashboard carries no extra chrome.
 */
export function SegmentBar(): ReactElement | null {
	const { active } = useSegment();
	if (!active) return null;
	return (
		<div className="mb-3 flex flex-nowrap items-center gap-x-3 overflow-x-auto rounded-xl border border-[color:rgb(var(--border))] px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
			<span data-chrome className="shrink-0 font-medium text-[color:var(--muted)] text-xs">
				Segment
			</span>
			<SegmentChips />
		</div>
	);
}

/**
 * What this tab does with the active segment, stated where its numbers are.
 *
 * A tab that cannot filter must SAY it cannot: several of these endpoints happily accept
 * path/country/device/channel and then ignore them in SQL, so "the request had the parameter" is not
 * evidence of anything. See TAB_SEGMENT_SUPPORT for the per-endpoint findings.
 *
 * `full` renders nothing — the chips above already say a filter is on, and the numbers agree with
 * them. Only a discrepancy needs words.
 */
export function SegmentNotice({ tab }: { tab: SegmentTab }): ReactElement | null {
	const { active } = useSegment();
	const support = TAB_SEGMENT_SUPPORT[tab];
	if (!active || support.level === 'full') return null;
	return (
		<p
			data-chrome
			role="note"
			className={cn(
				'rounded-lg px-3 py-2 text-xs',
				support.level === 'none' ? 'alert-warn' : 'alert-info',
			)}
		>
			<span className="font-semibold">
				{support.level === 'none'
					? 'This tab cannot apply the active segment. '
					: 'This tab applies the active segment only in part. '}
			</span>
			{support.note}
		</p>
	);
}
