// Top-N breakdown list: proportional horizontal bars whose width tracks the max count. Values are
// right-aligned and tabular; long keys truncate with a title tooltip. Pure CSS/Tailwind, no chart lib.
// When `onSelect` is supplied, rows become toggle buttons that cross-filter the dashboard.

import type { CountRow } from '@facet/shared';
import { Check, Layers } from 'lucide-react';
import { type CSSProperties, type ReactElement, useRef } from 'react';
import { cn } from '../lib/cn.js';
import { type Movement, formatNumber } from '../lib/format.js';
import { useSize } from '../lib/useSize.js';
import { Card, CardHeading } from './Card.js';
import { DeltaBadge } from './Delta.js';

// Approx height of one row (px) so the `fit` mode can show exactly as many rows as the tile is tall.
const ROW_H = 34;

/**
 * A hue per dimension, from the active palette's categorical ramp. Every breakdown list used to draw
 * the same single accent, which is what made a board of eight lists read as one flat monochrome
 * block — the whole point of a dark UI is that distinct things carry distinct colour. Dimensions are
 * a fixed, known set, so they're assigned explicitly (rather than hashed) to keep adjacent tiles on
 * the board from landing on the same hue. Anything unrecognised falls back to the chrome accent.
 */
const DIMENSION_HUES: Record<string, string> = {
	page: '--c1',
	referrer: '--c2',
	country: '--c3',
	region: '--c3',
	device: '--c4',
	screen: '--c4',
	browser: '--c5',
	'operating system': '--c6',
	os: '--c6',
	network: '--c2',
	connection: '--c4',
	language: '--c5',
	channel: '--c6',
	event: '--c3',
	interaction: '--c1',
};

/** Resolve a list title ("Top pages", "Referrers right now", "Countries") to its palette hue. */
export function hueForTitle(title: string): string {
	const t = title.toLowerCase();
	for (const [term, hue] of Object.entries(DIMENSION_HUES)) {
		if (t.includes(term)) return `var(${hue})`;
	}
	return 'rgb(var(--accent-rgb))';
}

/**
 * The per-row "inspect" control: opens that row's own composition without touching the board.
 *
 * It is a SIBLING of the row's cross-filter button, never nested inside it — a button inside a button
 * is invalid HTML, and the two gestures mean genuinely different things (re-scope the whole board vs.
 * ask what this one row is made of). Lives here rather than with the drill engine so the list and its
 * row furniture stay in one file, and so the drill module never has to import the list back.
 */
export function InspectButton({
	rowKey,
	open,
	controls,
	onClick,
}: {
	rowKey: string;
	open: boolean;
	controls?: string;
	onClick: () => void;
}): ReactElement {
	return (
		<button
			type="button"
			// Chrome, not data: Cmd+A should select the row's key and figure, not its controls.
			data-chrome
			// Lets the drill frame put focus back on THIS control when the panel closes — on a compact
			// tile the panel replaces the list, so this button is unmounted while the panel is open and
			// focus would otherwise be dropped on the document body.
			data-inspect-key={rowKey}
			aria-expanded={open}
			aria-controls={controls}
			aria-label={`Break down ${rowKey} by other dimensions`}
			onClick={onClick}
			className={cn(
				'shrink-0 self-stretch rounded-md px-1 transition-opacity',
				// Visible at rest so the affordance is discoverable at all, solid on hover/focus so it
				// reads as clickable BEFORE the click.
				open
					? 'text-[color:var(--ink)] opacity-100'
					: 'text-[color:var(--muted)] opacity-40 hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)] hover:opacity-100 focus-visible:opacity-100 group-hover/row:opacity-90',
			)}
		>
			<Layers className="h-3.5 w-3.5" aria-hidden="true" />
		</button>
	);
}

interface TopListProps {
	title: string;
	rows: CountRow[];
	action?: ReactElement;
	/** When provided, rows become toggle buttons that cross-filter the dashboard by their key. */
	onSelect?: (key: string) => void;
	/** The currently-filtered key for this dimension: highlighted, and toggled off on re-click. */
	activeKey?: string;
	/** Render just the list (no Card/heading) — the caller (e.g. a bento tile) supplies the frame. */
	bare?: boolean;
	/** Cap the number of rows shown. */
	limit?: number;
	/** Style for the dark "cut obsidian" board (light text + luminous bars). Default is the light theme
	 * used by the other tabs. */
	dark?: boolean;
	/** Show exactly as many rows as the tile is tall (min 1), so a squished tile never overflows or clips
	 * a half-row — it degrades to its top entries. For the elastic board's bare list tiles. */
	fit?: boolean;
	/** Explicit hue for this list's bars (a CSS colour). Overrides the per-dimension default. */
	accent?: string;
	/** How to render a row's value. Defaults to the plain count. REQUIRED wherever `count` is not a
	 * count: attribution's rows carry attributed REVENUE (packages/shared/src/stats.ts), and without
	 * this the same figure read as currency in one tier and a bare integer in the next. */
	format?: (value: number) => string;
	/** Per-key movement vs the equal-length preceding period. A key with no honest comparison is
	 * simply absent from the map and renders no badge — never a zero, never an invented percentage. */
	deltas?: ReadonlyMap<string, Movement>;
	/** Rows to append below the list (keys that left it), rendered muted with their own movement. */
	trailing?: ReactElement | null;
	/** Heading depth for the card title. 2 when this list IS a top-level section of its tab. */
	headingLevel?: 2 | 3;
	/** When provided, each row grows a second control that opens that row's own composition. It is a
	 * SIBLING of the cross-filter button, not a child — a button inside a button is invalid, and the
	 * two gestures mean different things (filter the board vs. inspect this row in place). */
	onInspect?: (key: string) => void;
	/** The row whose composition is currently open, for the control's pressed/expanded state. */
	inspectedKey?: string;
	/** Id of the panel the inspect control opens, for `aria-controls`. */
	inspectControls?: string;
}

export function TopList({
	title,
	rows,
	action,
	onSelect,
	activeKey,
	bare = false,
	limit,
	dark = false,
	fit = false,
	accent,
	format,
	deltas,
	trailing,
	headingLevel = 3,
	onInspect,
	inspectedKey,
	inspectControls,
}: TopListProps): ReactElement {
	const rootRef = useRef<HTMLDivElement>(null);
	const { height } = useSize(rootRef);
	// In fit mode, derive the visible count from the measured height (before first measure, fall back to
	// `limit` — the overflow-hidden wrapper clips any brief overshoot).
	const fitCount = fit
		? height > 0
			? Math.max(1, Math.floor(height / ROW_H))
			: (limit ?? 6)
		: undefined;
	const effLimit =
		fitCount != null ? Math.min(limit ?? Number.POSITIVE_INFINITY, fitCount) : limit;
	const shown = effLimit ? rows.slice(0, effLimit) : rows;
	const max = shown.reduce((acc, row) => Math.max(acc, row.count), 0);
	// Share is of the WHOLE dataset (all rows), not just the shown top-N, so a row's % reads as its
	// true portion of traffic rather than its portion of the visible slice.
	const total = rows.reduce((acc, row) => acc + row.count, 0);
	const interactive = Boolean(onSelect);
	const inspectable = Boolean(onInspect);
	// This list's hue: an explicit per-tile accent if the user picked one, else the dimension's own
	// colour. Published to the subtree as `--bar`; the .bar-fill rules in index.css derive the resting,
	// hover and selected strengths from it, so one variable drives every state.
	const hue = accent ?? hueForTitle(title);
	// Per-surface weights: the dark board wants luminous bars; the scrolling tabs sit calmer.
	const c = dark
		? {
				empty: 'text-[color:var(--muted)]',
				pct: 'text-[color:var(--muted)]',
				rowHover: 'hover:bg-[color:rgb(var(--hover))]',
			}
		: {
				empty: 'text-[color:var(--faint)]',
				pct: 'text-[color:var(--faint)]',
				rowHover: 'hover:bg-[color:rgb(var(--hover))]',
			};
	const cls =
		'group relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-lg px-2.5 py-2 text-left text-sm transition-colors';

	const body =
		shown.length === 0 && !trailing ? (
			<p className={cn('py-6 text-center text-sm', c.empty)}>No data yet</p>
		) : (
			<ul className="space-y-0.5">
				{shown.map((row) => {
					const width = max > 0 ? (row.count / max) * 100 : 0;
					const active = row.key === activeKey;
					const inner = (
						<>
							<span
								className="bar-fill absolute inset-y-1 left-0 rounded-md transition-[width] duration-500 ease-out"
								data-active={active}
								data-soft={!dark}
								style={{ width: `${width}%` }}
								data-testid="toplist-bar"
								aria-hidden="true"
							/>
							<span
								className="relative z-10 flex min-w-0 items-center gap-1.5 font-medium text-[color:var(--ink)]"
								style={active ? { color: 'var(--bar)' } : undefined}
								title={row.key}
							>
								{active ? (
									<Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
								) : null}
								<span className="truncate">{row.key}</span>
							</span>
							{/* IMPORTANT: the key is the only shrinkable member of this row, so on a narrow
							    tile the three fixed ones squeezed it to "/…" and the list became six
							    anonymous bars. Least-informative-first, they drop out instead: a row
							    without its share still reads, a row without its key does not. */}
							<span className="relative z-10 flex shrink-0 items-baseline gap-1.5">
								<span
									className={cn(
										'text-[11px] tabular-nums @max-[16rem]/tile:hidden',
										c.pct,
									)}
								>
									{total > 0 ? Math.round((row.count / total) * 100) : 0}%
								</span>
								<span className="font-semibold text-[color:var(--ink)] tabular-nums">
									{(format ?? formatNumber)(row.count)}
								</span>
								{/* The movement sits after the figure it qualifies, so a row reads
								    "/pricing 16,514 +22%" in one pass. Absent when unmeasurable. */}
								<DeltaBadge
									movement={deltas?.get(row.key)}
									size="sm"
									className="@max-[13rem]/tile:hidden"
								/>
							</span>
						</>
					);
					const inspecting = inspectable && row.key === inspectedKey;
					const main = interactive ? (
						<button
							type="button"
							// A cross-filter row is a <button>, but its key and figure are
							// DATA — opt them back into Cmd+A, which excludes buttons by default.
							data-selectable
							aria-pressed={active}
							onClick={() => onSelect?.(row.key)}
							className={cn(
								cls,
								c.rowHover,

								active && 'ring-1 ring-[color:var(--bar)]',
							)}
						>
							{inner}
						</button>
					) : (
						<div className={cn(cls, c.rowHover)}>{inner}</div>
					);
					if (!inspectable) return <li key={row.key}>{main}</li>;
					return (
						<li
							key={row.key}
							className={cn(
								'group/row flex items-stretch gap-0.5 rounded-lg',
								// Instant feedback: the inspected row stays marked while its panel is open.
								inspecting && 'bg-[color:rgb(var(--hover))]',
							)}
						>
							<div className="min-w-0 flex-1">{main}</div>
							<InspectButton
								rowKey={row.key}
								open={inspecting}
								controls={inspectControls}
								onClick={() => onInspect?.(row.key)}
							/>
						</li>
					);
				})}
			</ul>
		);

	const content = trailing ? (
		<>
			{body}
			{trailing}
		</>
	) : (
		body
	);

	if (bare) {
		return (
			<div
				ref={rootRef}
				className="h-full overflow-hidden"
				style={{ '--bar': hue } as CSSProperties}
			>
				{content}
			</div>
		);
	}
	return (
		<Card style={{ '--bar': hue } as CSSProperties}>
			<CardHeading action={action} level={headingLevel}>
				{title}
			</CardHeading>
			{content}
		</Card>
	);
}
