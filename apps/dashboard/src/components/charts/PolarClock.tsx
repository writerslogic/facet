// The 7 × 24 activity grid as a radial chart: hours run clockwise from midnight at the top, weekdays
// run outward from the centre. Two readings of the same data — `grid` shows every one of the 168
// cells, `nightingale` collapses to the 24-hour marginal as petals.
//
// TIMEZONE. The endpoint is UTC and says so in `timezone`, because the server was never told the
// site's timezone and refuses to guess one. This chart therefore DEFAULTS to UTC and labels every
// axis "UTC". A local view is available, but it is the client's own arithmetic and is labelled with
// the exact offset it applied, never just "local":
//
//   * it is refused outright when the viewer's offset is not a whole number of hours (India, Nepal,
//     the Chathams …). The grid's smallest unit is one hour; shifting by 5h30m would have to split
//     every cell, and there is no data to split it WITH — counts inside an hour are not resolved any
//     finer. Rounding to 5h or 6h would silently mislabel every number on the chart;
//   * when the range straddles a DST change the offset is not constant over the data, so the caller
//     states which single offset was applied. One folded grid cannot represent two offsets, and the
//     alternative — quietly using whichever offset happens to hold today — is the bug that warning
//     exists to prevent.
//
// The shift only ever moves whole cells (`shiftClockCells`), so no count is invented, split or
// dropped: the shifted grid is a permutation of the grid the server sent.

import type { ClockCell } from '@facet/shared';
import { type ReactElement, useMemo, useRef } from 'react';
import { useHoverTarget, useSpring } from '../../lib/chartInteraction.js';
import { cn } from '../../lib/cn.js';
import { formatNumber } from '../../lib/format.js';
import { useSize } from '../../lib/useSize.js';
import { ChartNote } from './ChartChrome.js';
import { ChartTooltip, TooltipRow } from './ChartTooltip.js';
import { bandFill, bandOf, intensityThresholds } from './ramp.js';
import { useRovingGrid } from './rovingGrid.js';

const DAYS = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
] as const;
const SHORT_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

/** Day-major index into the 168-cell grid, exactly the order the endpoint returns `cells` in. */
export function cellIndex(day: number, hour: number): number {
	return day * 24 + hour;
}

/** A zero-filled, day-major 7 × 24 grid. */
function emptyGrid(): ClockCell[] {
	return Array.from({ length: 168 }, (_, i) => ({
		day: Math.floor(i / 24),
		hour: i % 24,
		pageviews: 0,
		events: 0,
	}));
}

/**
 * Shift a UTC grid by a whole number of hours. Each cell's counts move to the (day, hour) they
 * belong to in the shifted frame, with the weekday rolling over when the hour wraps past midnight.
 * Totals are preserved exactly: this is a permutation of 168 buckets, not a re-aggregation.
 */
export function shiftClockCells(cells: readonly ClockCell[], offsetHours: number): ClockCell[] {
	const grid = emptyGrid();
	for (const cell of cells) {
		const shifted = cell.hour + offsetHours;
		const hour = ((shifted % 24) + 24) % 24;
		const dayRoll = Math.floor(shifted / 24);
		const day = (((cell.day + dayRoll) % 7) + 7) % 7;
		const target = grid[cellIndex(day, hour)] as ClockCell;
		target.pageviews += cell.pageviews;
		target.events += cell.events;
	}
	return grid;
}

/** Pageviews per hour of the (possibly shifted) frame — the nightingale's radial marginal. */
export function hourMarginal(cells: readonly ClockCell[]): number[] {
	const out = new Array<number>(24).fill(0);
	for (const cell of cells) out[cell.hour] = (out[cell.hour] ?? 0) + cell.pageviews;
	return out;
}

const SIZE = 320;
const CENTRE = SIZE / 2;
const INNER = 46;
const OUTER = 142;
/** Radians per hour sector, laid out clockwise with hour 0 starting at 12 o'clock. */
const SECTOR = (Math.PI * 2) / 24;

function polar(radius: number, angle: number): [number, number] {
	// The −cos/+sin pairing puts angle 0 at 12 o'clock and runs positive angles clockwise, so the
	// chart is read the way every clock face is read.
	return [CENTRE + radius * Math.sin(angle), CENTRE - radius * Math.cos(angle)];
}

/** Annular sector between two radii and two angles. */
export function annularSector(r0: number, r1: number, a0: number, a1: number): string {
	const [x0, y0] = polar(r1, a0);
	const [x1, y1] = polar(r1, a1);
	const [x2, y2] = polar(r0, a1);
	const [x3, y3] = polar(r0, a0);
	const large = a1 - a0 > Math.PI ? 1 : 0;
	return [
		`M${x0.toFixed(2)},${y0.toFixed(2)}`,
		`A${r1.toFixed(2)},${r1.toFixed(2)} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`,
		`L${x2.toFixed(2)},${y2.toFixed(2)}`,
		`A${r0.toFixed(2)},${r0.toFixed(2)} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)}`,
		'Z',
	].join(' ');
}

export interface PolarClockProps {
	/** The grid as it should be READ — already shifted by the caller, if it is shifting. */
	cells: readonly ClockCell[];
	variant: 'grid' | 'nightingale';
	/** How the time frame must be named on every label — e.g. `UTC` or `UTC+2`. */
	frameLabel: string;
	/** The DST / non-whole-offset caveat, when there is one. */
	note?: string | null;
}

/**
 * Past this width-to-height ratio the caption moves from under the dial to beside it.
 *
 * A dial is square and letterboxes to whichever side is shorter, so in a wide tile it was drawing a
 * coin in the middle of an empty band — and the caption underneath was taking height the dial had
 * already run out of. Beside it, the caption costs no height at all and the dial grows to fill the
 * tile. 1.3 rather than 1: at ratios just over square the side column would be too narrow to set text
 * in, and the dial gains almost nothing.
 */
const SIDE_CAPTION_RATIO = 1.3;

export function PolarClock({ cells, variant, frameLabel, note }: PolarClockProps): ReactElement {
	const wrap = useRef<HTMLDivElement>(null);
	// The PLOT box, not the whole component: the caption takes space in one axis or the other, and
	// measuring the outer box made the letterbox transform — and therefore the hit-testing — disagree
	// with what the browser drew whenever the caption was the reason height ran out.
	const plot = useRef<HTMLDivElement>(null);
	const size = useSize(plot);
	const outer = useSize(wrap);
	const boxWidth = size.width || SIZE;
	const boxHeight = size.height || SIZE;
	// 0 is "not measured yet" — hold the column layout until there is a real box to judge.
	const sideCaption = outer.height > 0 && outer.width > outer.height * SIDE_CAPTION_RATIO;

	// Normalize to a full day-major grid: the endpoint always sends 168 cells, but folding through
	// `shiftClockCells` or a partial fixture must not leave holes in the geometry.
	const ordered = useMemo(() => {
		const grid = emptyGrid();
		for (const c of cells) {
			const slot = grid[cellIndex(c.day, c.hour)];
			if (!slot) continue;
			slot.pageviews += c.pageviews;
			slot.events += c.events;
		}
		return grid;
	}, [cells]);

	const thresholds = useMemo(
		() => intensityThresholds(ordered.map((c) => c.pageviews)),
		[ordered],
	);
	const byHour = useMemo(() => hourMarginal(ordered), [ordered]);
	const hourThresholds = useMemo(() => intensityThresholds(byHour), [byHour]);
	const total = ordered.reduce((s, c) => s + c.pageviews, 0);
	const maxHour = byHour.reduce((m, v) => Math.max(m, v), 0) || 1;
	const peak = ordered.reduce<ClockCell | null>(
		(best, c) => (best == null || c.pageviews > best.pageviews ? c : best),
		null,
	);

	// The two views share a centre and an angular axis, so switching them is a transition rather than
	// a swap: one spring collapses the seven day rings into the single band the petals grow from.
	// Reduced motion snaps it — `useSpring` owns that decision, nothing here re-checks it.
	const morph = useSpring(variant === 'grid' ? 0 : 1, { stiffness: 150, damping: 22 });
	const ringSpan = (OUTER - INNER) / 7;
	const spread = 1 - morph;
	const bandBase = INNER + ((OUTER - INNER) * (1 - spread)) / 2;

	const roving = useRovingGrid(variant === 'grid' ? 168 : 24, {
		horizontal: 1,
		vertical: variant === 'grid' ? 24 : 6,
	});

	// Pointer → cell, in viewBox units after undoing the `xMidYMid meet` letterbox.
	const scale = Math.min(boxWidth / SIZE, boxHeight / SIZE);
	const offsetX = (boxWidth - SIZE * scale) / 2;
	const offsetY = (boxHeight - SIZE * scale) / 2;
	// Resolved against the PLOT box, which is also where the handlers and the tooltip live — so the
	// pointer maths cannot drift from the drawn geometry when the caption moves to the side.
	const { hover, handlers } = useHoverTarget<{ hour: number; day: number | null }>(
		plot,
		(localX, localY) => {
			const vx = (localX - offsetX) / scale - CENTRE;
			const vy = (localY - offsetY) / scale - CENTRE;
			const radius = Math.hypot(vx, vy);
			if (radius < INNER || radius > OUTER) return null;
			const angle = (Math.atan2(vx, -vy) + Math.PI * 2) % (Math.PI * 2);
			const hour = Math.min(23, Math.floor(angle / SECTOR));
			if (variant === 'nightingale') return { hour, day: null };
			const day = Math.min(6, Math.max(0, Math.floor((radius - INNER) / ringSpan)));
			return { hour, day };
		},
	);

	const hovered =
		hover && hover.datum.day != null
			? (ordered[cellIndex(hover.datum.day, hover.datum.hour)] ?? null)
			: null;
	const hoverValue = hovered ? hovered.pageviews : (byHour[hover?.datum.hour ?? 0] ?? 0);

	return (
		<div
			ref={wrap}
			className={cn(
				'flex h-full min-h-0 w-full gap-3',
				sideCaption ? 'flex-row items-center justify-center' : 'flex-col',
			)}
		>
			{/* The measured box IS the box the handlers and the tooltip sit on. It used to be neither:
			    this ref was left unattached by a refactor, so the letterbox transform was computed
			    against a 320×320 box that did not exist and every hover resolved to the wrong cell.
			    Beside a caption the box is pinned to a SQUARE: a dial letterboxes to its shorter side,
			    so a `flex-1` box wider than it is tall is not room for the chart, it is a gap between
			    the chart and its own caption. */}
			<div
				ref={plot}
				style={
					sideCaption ? { width: Math.min(outer.height, outer.width - 140) } : undefined
				}
				className={cn(
					'relative min-h-0 self-stretch',
					sideCaption ? 'shrink-0' : 'min-w-0 flex-1',
				)}
				{...handlers}
			>
				<svg
					viewBox={`0 0 ${SIZE} ${SIZE}`}
					preserveAspectRatio="xMidYMid meet"
					className="h-full w-full"
					// A grid of read-only cells, which is exactly what this is: `role="grid"` +
					// `row`/`gridcell` is the one ARIA structure that lets a cell be focusable without
					// claiming to be a control that does something when activated. Hours are the columns
					// in both variants, so the nightingale is a single-row grid rather than a new shape.
					// biome-ignore lint/a11y/useSemanticElements: a <table> cannot be drawn inside an <svg>; the sr-only table below IS the tabular form
					role="grid"
					aria-label={`Activity by weekday and hour, ${frameLabel}`}
					aria-rowcount={variant === 'grid' ? 7 : 1}
					aria-colcount={24}
					onKeyDown={roving.onKeyDown}
				>
					{variant === 'grid' ? (
						DAYS.map((dayName, day) => (
							<g
								key={dayName}
								// biome-ignore lint/a11y/useSemanticElements: no <tr> inside <svg> — see the grid role above
								role="row"
								aria-rowindex={day + 1}
							>
								{Array.from({ length: 24 }, (_, hour) => {
									const cell = ordered[cellIndex(day, hour)] as ClockCell;
									const index = cellIndex(day, hour);
									const band = bandOf(cell.pageviews, thresholds);
									const r0 = bandBase + day * ringSpan * spread;
									const r1 = r0 + Math.max(1, ringSpan * spread);
									const a0 = hour * SECTOR;
									const label = `${dayName} ${String(hour).padStart(2, '0')}:00 ${frameLabel}: ${formatNumber(cell.pageviews)} pageviews`;
									return (
										<g
											// biome-ignore lint/suspicious/noArrayIndexKey: day and hour ARE the identity here, a fixed 7 x 24 positional grid
											key={`${day}-${hour}`}
											ref={roving.register(index)}
											tabIndex={roving.tabIndexFor(index)}
											// biome-ignore lint/a11y/useSemanticElements: no <td> inside <svg> — see the grid role above
											role="gridcell"
											aria-colindex={hour + 1}
											aria-label={label}
											onFocus={() => roving.setActive(index)}
										>
											<path
												d={annularSector(r0, r1, a0, a0 + SECTOR)}
												fill={
													band < 0 ? 'rgb(var(--hover))' : bandFill(band)
												}
												stroke="rgb(var(--bg))"
												strokeWidth={0.5}
											>
												<title>{label}</title>
											</path>
										</g>
									);
								})}
							</g>
						))
					) : (
						<g
							// biome-ignore lint/a11y/useSemanticElements: no <tr> inside <svg> — see the grid role above
							role="row"
							aria-rowindex={1}
						>
							{byHour.map((value, hour) => {
								// r ∝ √value so AREA tracks the count. A linear radius quadruples
								// the ink for a doubled hour — the classic nightingale
								// exaggeration.
								const reach =
									INNER + Math.sqrt(value / maxHour) * (OUTER - INNER) * morph;
								const band = bandOf(value, hourThresholds);
								const a0 = hour * SECTOR;
								const label = `${String(hour).padStart(2, '0')}:00 ${frameLabel}: ${formatNumber(value)} pageviews`;
								return (
									<g
										// biome-ignore lint/suspicious/noArrayIndexKey: the index IS the hour, a fixed positional axis
										key={hour}
										ref={roving.register(hour)}
										tabIndex={roving.tabIndexFor(hour)}
										// biome-ignore lint/a11y/useSemanticElements: no <td> inside <svg> — see the grid role above
										role="gridcell"
										aria-colindex={hour + 1}
										aria-label={label}
										onFocus={() => roving.setActive(hour)}
									>
										<path
											d={annularSector(
												INNER,
												Math.max(INNER + 0.5, reach),
												a0 + SECTOR * 0.06,
												a0 + SECTOR * 0.94,
											)}
											fill={band < 0 ? 'rgb(var(--hover))' : bandFill(band)}
											stroke="rgb(var(--bg))"
											strokeWidth={0.5}
										>
											<title>{label}</title>
										</path>
									</g>
								);
							})}
						</g>
					)}
					{[0, 6, 12, 18].map((hour) => {
						const [x, y] = polar(OUTER + 12, (hour + 0.5) * SECTOR);
						return (
							<text
								key={hour}
								x={x}
								y={y}
								textAnchor="middle"
								dominantBaseline="central"
								className="text-[10px]"
								fill="var(--faint)"
							>
								{`${String(hour).padStart(2, '0')}h`}
							</text>
						);
					})}
					{/* Ring labels sit on the midnight spoke, each on its own opaque chip. Without the chip
				    they were two-letter smudges over a lit cell; with it, the reader can tell which
				    ring is Wednesday without hovering. Same trick the Sankey uses for its middle
				    column labels. */}
					{variant === 'grid'
						? SHORT_DAYS.map((day, index) => {
								const y = CENTRE - (bandBase + (index + 0.5) * ringSpan * spread);
								return (
									<g key={day} opacity={spread}>
										<rect
											x={CENTRE - 7}
											y={y - 4.5}
											width={14}
											height={9}
											rx={2}
											fill="rgb(var(--bg))"
											fillOpacity={0.82}
										/>
										<text
											x={CENTRE}
											y={y}
											textAnchor="middle"
											dominantBaseline="central"
											className="text-[8px]"
											fill="var(--ink)"
										>
											{day}
										</text>
									</g>
								);
							})
						: null}
					{/* The frame label sits at the centre so no one can read this chart without seeing
				    which clock its hours are on. */}
					<text
						x={CENTRE}
						y={CENTRE - 6}
						textAnchor="middle"
						className="font-semibold text-[11px]"
						fill="var(--ink)"
					>
						{frameLabel}
					</text>
					<text
						x={CENTRE}
						y={CENTRE + 8}
						textAnchor="middle"
						className="text-[9px]"
						fill="var(--faint)"
					>
						{`${formatNumber(total)} pv`}
					</text>
				</svg>
				{hover ? (
					<ChartTooltip
						x={hover.x}
						y={hover.y}
						containerWidth={boxWidth}
						containerHeight={boxHeight}
					>
						<p className="mb-1 font-semibold">
							{hovered
								? `${DAYS[hovered.day]} ${String(hovered.hour).padStart(2, '0')}:00`
								: `${String(hover.datum.hour).padStart(2, '0')}:00`}
						</p>
						<TooltipRow
							label="Pageviews"
							value={formatNumber(hoverValue)}
							swatch={bandFill(
								Math.max(
									0,
									bandOf(hoverValue, hovered ? thresholds : hourThresholds),
								),
							)}
						/>
						{hovered ? (
							<TooltipRow label="Events" value={formatNumber(hovered.events)} />
						) : null}
						<TooltipRow label="Time frame" value={frameLabel} />
					</ChartTooltip>
				) : null}
			</div>
			<ChartNote className={sideCaption ? 'max-w-[15rem] self-center' : undefined}>
				{`Hours run clockwise from midnight ${frameLabel}${
					variant === 'grid'
						? '; rings are weekdays, Sunday innermost'
						: '; petal area is pageviews'
				}.`}
				{note ? ` ${note}` : ''}
			</ChartNote>
			<table className="sr-only">
				<caption>
					{`Pageviews by weekday and hour in ${frameLabel}, ${formatNumber(total)} in total`}
					{peak && peak.pageviews > 0
						? `; the busiest hour was ${DAYS[peak.day]} ${String(peak.hour).padStart(2, '0')}:00 with ${formatNumber(peak.pageviews)}`
						: ''}
					{`. ${note ?? ''}`}
				</caption>
				<thead>
					<tr>
						<th scope="col">{`Hour (${frameLabel})`}</th>
						{DAYS.map((day) => (
							<th key={day} scope="col">
								{day}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{Array.from({ length: 24 }, (_, hour) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional hour rows
						<tr key={hour}>
							<th scope="row">{`${String(hour).padStart(2, '0')}:00`}</th>
							{DAYS.map((day, dayIndex) => (
								<td key={day}>
									{formatNumber(
										ordered[cellIndex(dayIndex, hour)]?.pageviews ?? 0,
									)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
