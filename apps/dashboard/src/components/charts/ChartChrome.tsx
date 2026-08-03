// The furniture every chart on the board wears, in one place.
//
// WHY: eight charts arrived from five authors. They already shared `chartInteraction` and
// `ChartTooltip`, so hover and easing matched — but the parts *around* the plot did not. One footnote
// was 10px `--faint` and marked `data-chrome`, the next was the same size and not marked at all (so
// Cmd+A dragged an explanatory sentence in with the numbers); one chart's empty state was a padded
// `EmptyState` card rendered INSIDE a tile that is already a card, another's was a bare centred
// sentence. That is what makes a dashboard read as a gallery.
//
// Everything here is furniture, so everything here is `data-chrome`: a footnote explaining the
// anonymity floor is not data, and the sr-only tables next to each chart are what a reader copies.

import { CalendarRange, Inbox, ShieldCheck } from 'lucide-react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * The line under a plot that qualifies it — units, an anonymity floor, a truncated tail, which clock
 * the hours are on. One size, one colour, one place: directly under the plot, never above it.
 */
export function ChartNote({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}): ReactElement {
	return (
		<p
			data-chrome
			className={cn('shrink-0 text-[10px] leading-snug text-[color:var(--faint)]', className)}
		>
			{children}
		</p>
	);
}

/** Why a chart has nothing to draw. Never colour alone — each reason carries its own icon and its own
 * sentence, so the three are told apart in greyscale and by a screen reader. */
export type ChartEmptyReason =
	/** The query succeeded and the answer is zero. */
	| 'empty'
	/** Withheld: the slice is below the anonymity floor. A privacy guarantee, not a failure. */
	| 'suppressed'
	/** There is data, just not in the window the reader is looking at. */
	| 'range';

const REASON = {
	empty: { Icon: Inbox, lead: 'Nothing to show yet' },
	suppressed: { Icon: ShieldCheck, lead: 'Withheld for privacy' },
	range: { Icon: CalendarRange, lead: 'Nothing in this range' },
} as const satisfies Record<ChartEmptyReason, { Icon: typeof Inbox; lead: string }>;

/**
 * The icon + one-line lead for a state, on its own — for a box whose explanation is too specific to
 * fold into `ChartEmpty` (the session distribution's suppression panel names the exact anonymity
 * floor and shows progress toward it). Sharing the lead is what keeps "withheld for privacy" reading
 * the same wherever it appears, even when what follows it does not.
 */
export function ChartStateLead({
	reason,
	title,
	className,
}: {
	reason: ChartEmptyReason;
	title?: string;
	className?: string;
}): ReactElement {
	const { Icon, lead } = REASON[reason];
	return (
		<p
			className={cn(
				'flex items-center gap-1.5 font-semibold text-[color:var(--ink)] text-sm',
				className,
			)}
		>
			<Icon className="size-4 shrink-0 text-[color:var(--faint)]" aria-hidden="true" />
			{title ?? lead}
		</p>
	);
}

/**
 * The in-tile "no chart" state. Compact by construction: a tile is already a card, so this draws no
 * second card and no padding a 118px-tall tile cannot afford.
 *
 * `title` overrides the reason's default lead when a box can say something more specific; `children`
 * is the explanation, and is dropped automatically when the tile is too short to hold it.
 */
export function ChartEmpty({
	reason = 'empty',
	title,
	children,
	compact = false,
}: {
	reason?: ChartEmptyReason;
	title?: string;
	children?: ReactNode;
	/** Set when the tile has no room for the explanation — the lead alone still says which case it is. */
	compact?: boolean;
}): ReactElement {
	const { Icon, lead } = REASON[reason];
	return (
		<div
			data-chrome
			className="flex h-full min-h-0 flex-col items-center justify-center gap-1.5 px-3 text-center"
		>
			<Icon className="size-4 shrink-0 text-[color:var(--faint)]" aria-hidden="true" />
			<p className="font-semibold text-[color:var(--muted)] text-xs">{title ?? lead}</p>
			{children && !compact ? (
				<p className="max-w-[34ch] text-[11px] text-[color:var(--faint)] leading-snug">
					{children}
				</p>
			) : null}
		</div>
	);
}

/** One row of a chart key: the mark's own colour, what it is, and its number. */
export interface ChartKeyItem {
	key: string;
	label: string;
	value: string;
	/** Any CSS colour — the mark's actual fill, so the key cannot drift from the plot. */
	swatch: string;
	/** Secondary figure (a share, a rate); omitted when there is nothing useful to add. */
	detail?: string;
}

/**
 * The key beside a plot. Deliberately NOT interactive and `aria-hidden`: the marks themselves are the
 * controls (a sunburst's ring-1 arcs are tab stops, a bubble is a button), and duplicating them here
 * would put two tab stops on every datum for one action. This is a colour-to-name lookup and the
 * numbers a radial chart structurally cannot print on itself; the sr-only table carries the rest.
 *
 * `onHover` is a pointer enhancement only — it highlights the matching mark. Nothing is reachable
 * solely through it.
 */
export function ChartKey({
	items,
	onHover,
	highlighted,
	className,
	style,
}: {
	items: readonly ChartKeyItem[];
	onHover?: (key: string | null) => void;
	highlighted?: string | null;
	className?: string;
	/** Placement, for a chart that positions its key against its own measured geometry (see Sunburst). */
	style?: CSSProperties;
}): ReactElement {
	return (
		<ul
			aria-hidden="true"
			data-chrome
			className={cn('flex min-w-0 flex-col gap-1 overflow-hidden', className)}
			style={style}
			onPointerLeave={onHover ? () => onHover(null) : undefined}
		>
			{items.map((item) => {
				const dim = highlighted != null && highlighted !== item.key;
				return (
					<li
						key={item.key}
						onPointerEnter={onHover ? () => onHover(item.key) : undefined}
						className={cn(
							'flex min-w-0 items-baseline gap-1.5 text-[10px] transition-opacity duration-150',
							dim ? 'opacity-45' : 'opacity-100',
						)}
					>
						<span
							className="inline-block size-1.5 shrink-0 translate-y-px rounded-[2px]"
							style={{ backgroundColor: item.swatch }}
						/>
						<span
							className={cn(
								'min-w-0 flex-1 truncate',
								highlighted === item.key
									? 'text-[color:var(--ink)]'
									: 'text-[color:var(--muted)]',
							)}
						>
							{item.label}
						</span>
						<span className="shrink-0 tabular-nums text-[color:var(--ink)]">
							{item.value}
						</span>
						{item.detail ? (
							<span className="w-8 shrink-0 text-right tabular-nums text-[color:var(--faint)]">
								{item.detail}
							</span>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
