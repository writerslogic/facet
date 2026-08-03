// Pageviews per UTC day, GitHub-contribution style: one column per week, one row per weekday.
// Clicking a day narrows the board to that day.
//
// THE HONESTY PROBLEM this chart has to solve. A contribution grid is rectangular; a date range is
// not. The selected range almost never starts on a Sunday or ends on a Saturday, so the first and
// last columns contain cells for days that were never queried. Filling them with zeros would draw
// "no traffic" over "outside the range" — a fabricated claim, and the most plausible-looking kind.
// Those cells are therefore rendered as OUTLINES with no fill and a title that says so, visually
// distinct from an in-range day that genuinely saw nothing (which gets a filled outline on the
// board's `--hover` tint). Three states, three appearances, all three labelled in the legend.
//
// Everything is UTC, matching the clock endpoint and the board's own range handling (`state.ts`
// parses date inputs as UTC day boundaries), so a day here is the same day everywhere else.

import { type ReactElement, useMemo, useRef } from 'react';
import { useHoverTarget, useSpring } from '../../lib/chartInteraction.js';
import { formatNumber } from '../../lib/format.js';
import { useSize } from '../../lib/useSize.js';
import { ChartTooltip, TooltipRow } from './ChartTooltip.js';
import { bandFill, bandOf, intensityThresholds } from './ramp.js';
import { useRovingGrid } from './rovingGrid.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
] as const;

/** Midnight UTC of the day containing `ms`. */
export function utcDayStart(ms: number): number {
	return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** `YYYY-MM-DD` for a UTC day start — the label, and the stable key for a cell. */
export function utcDayKey(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export interface CalendarCell {
	/** Midnight UTC. */
	day: number;
	pageviews: number;
	/** False for a cell the grid needs to stay rectangular but the range never covered. */
	inRange: boolean;
	/** Column (week) and row (UTC weekday, 0 = Sunday). */
	column: number;
	row: number;
}

/**
 * Build the week columns for `[start, end)`.
 *
 * Columns run from the Sunday on or before the range's first UTC day to the Saturday on or after its
 * last. Because a UTC day is exactly 86 400 000 ms with no DST — the whole reason the endpoint and
 * this grid are UTC — the weekday of a day is `floor(ms / DAY_MS + 4) mod 7` (the epoch fell on a
 * Thursday) and stepping a day is a fixed addition. A local-time calendar would need real date
 * arithmetic here, and would silently produce a 23- or 25-hour "day" twice a year.
 *
 * `counts` is keyed by UTC day start; a day inside the range with no entry is a real zero.
 */
export function calendarCells(
	start: number,
	end: number,
	counts: ReadonlyMap<number, number>,
): CalendarCell[] {
	const firstDay = utcDayStart(start);
	// `end` is exclusive. A range ending exactly at midnight covers up to the previous day.
	const lastDay = utcDayStart(end - 1);
	if (lastDay < firstDay) return [];
	const weekdayOf = (ms: number): number => (Math.floor(ms / DAY_MS) + 4) % 7;
	const gridStart = firstDay - weekdayOf(firstDay) * DAY_MS;
	const gridEnd = lastDay + (6 - weekdayOf(lastDay)) * DAY_MS;
	const cells: CalendarCell[] = [];
	for (let day = gridStart, i = 0; day <= gridEnd; day += DAY_MS, i++) {
		cells.push({
			day,
			pageviews: counts.get(day) ?? 0,
			inRange: day >= firstDay && day <= lastDay,
			column: Math.floor(i / 7),
			row: i % 7,
		});
	}
	return cells;
}

export interface CalendarHeatmapProps {
	/** Range the board is showing, so the grid can mark what it never covered. */
	start: number;
	end: number;
	/** Pageviews per UTC day start. Days absent from the map but inside the range are real zeros. */
	counts: ReadonlyMap<number, number>;
	/** The day currently drilled into (UTC day start), if any. */
	selectedDay?: number | null;
	onSelectDay?: (dayStart: number) => void;
}

const CELL = 13;
const GAP = 3;
const LEFT = 30;
const TOP = 16;

export function CalendarHeatmap({
	start,
	end,
	counts,
	selectedDay,
	onSelectDay,
}: CalendarHeatmapProps): ReactElement {
	const wrap = useRef<HTMLDivElement>(null);
	const plot = useRef<HTMLDivElement>(null);
	const size = useSize(plot);
	const cells = useMemo(() => calendarCells(start, end, counts), [start, end, counts]);
	const columns = cells.length === 0 ? 0 : (cells[cells.length - 1] as CalendarCell).column + 1;
	const thresholds = useMemo(
		() => intensityThresholds(cells.filter((c) => c.inRange).map((c) => c.pageviews)),
		[cells],
	);

	const width = LEFT + columns * (CELL + GAP);
	const height = TOP + 7 * (CELL + GAP);
	const boxWidth = size.width || width;
	const boxHeight = size.height || height;
	const xOf = (column: number): number => LEFT + column * (CELL + GAP);
	const yOf = (row: number): number => TOP + row * (CELL + GAP);

	// The svg is sized explicitly rather than stretched, for two reasons. A contribution grid is read
	// by cell DENSITY, so a 7-day range blown up to fill a wide tile reads as a different chart — the
	// scale is therefore capped at 1 (cells never exceed their natural 13px). And because this code
	// computes the box itself, the hit-testing and the button overlay below share exactly the
	// transform the browser applied, at any tile size, with no layout read per frame.
	const scale = Math.min(boxWidth / width, boxHeight / height, 1);
	const offsetX = (boxWidth - width * scale) / 2;
	const offsetY = (boxHeight - height * scale) / 2;
	const { hover, handlers } = useHoverTarget<CalendarCell>(plot, (localX, localY) => {
		const vx = (localX - offsetX) / scale;
		const vy = (localY - offsetY) / scale;
		const column = Math.floor((vx - LEFT) / (CELL + GAP));
		const row = Math.floor((vy - TOP) / (CELL + GAP));
		if (column < 0 || row < 0 || row > 6) return null;
		return cells.find((c) => c.column === column && c.row === row) ?? null;
	});

	// The selection ring grows on a spring, so drilling into a day is a movement rather than a flash.
	const selected = cells.find((c) => c.day === selectedDay && c.inRange) ?? null;
	const ring = useSpring(selected ? 1 : 0, { stiffness: 260, damping: 22 });

	const inRange = cells.filter((c) => c.inRange);
	// In-range days are contiguous, so +1 is the next day and +7 the same weekday a column right.
	const roving = useRovingGrid(inRange.length, { horizontal: 7, vertical: 1 });
	const total = inRange.reduce((s, c) => s + c.pageviews, 0);
	const busiest = inRange.reduce<CalendarCell | null>(
		(best, c) => (best == null || c.pageviews > best.pageviews ? c : best),
		null,
	);

	// Month label above the first column whose week contains that month's first in-range day. Two
	// months can begin in the SAME column (a range starting mid-week late in a month), and stacking
	// both there rendered them on top of each other — one unreadable smear. Only the first month to
	// claim a column gets the label; the rest are still named on every cell's title and in the table.
	const monthLabels = useMemo(() => {
		const seenMonth = new Set<number>();
		const claimedColumn = new Set<number>();
		const out: { column: number; label: string }[] = [];
		for (const c of cells) {
			if (!c.inRange) continue;
			const month = new Date(c.day).getUTCMonth();
			if (seenMonth.has(month)) continue;
			seenMonth.add(month);
			if (claimedColumn.has(c.column)) continue;
			claimedColumn.add(c.column);
			out.push({ column: c.column, label: MONTHS[month] as string });
		}
		return out;
	}, [cells]);

	return (
		<div ref={wrap} className="relative flex h-full w-full flex-col gap-2" {...handlers}>
			<div ref={plot} className="relative min-h-0 w-full flex-1">
				<svg
					viewBox={`0 0 ${width} ${height}`}
					className="absolute"
					style={{
						left: offsetX,
						top: offsetY,
						width: width * scale,
						height: height * scale,
					}}
					role={onSelectDay ? 'group' : 'img'}
					aria-label="Pageviews per UTC day"
				>
					{monthLabels.map((m) => (
						<text
							key={m.label}
							x={xOf(m.column)}
							y={TOP - 5}
							className="text-[9px]"
							fill="var(--faint)"
						>
							{m.label}
						</text>
					))}
					{[1, 3, 5].map((row) => (
						<text
							key={row}
							x={LEFT - 6}
							y={yOf(row) + CELL / 2}
							textAnchor="end"
							dominantBaseline="central"
							className="text-[9px]"
							fill="var(--faint)"
						>
							{WEEKDAYS[row]}
						</text>
					))}
					{cells.map((c) => {
						const band = c.inRange ? bandOf(c.pageviews, thresholds) : -1;
						const isSelected = selected?.day === c.day;
						const date = utcDayKey(c.day);
						const title = c.inRange
							? `${date} (UTC): ${formatNumber(c.pageviews)} pageviews`
							: `${date}: outside the selected range — not queried`;
						return (
							<g key={date}>
								<rect
									x={xOf(c.column)}
									y={yOf(c.row)}
									width={CELL}
									height={CELL}
									rx={2.5}
									fill={
										!c.inRange
											? 'transparent'
											: band < 0
												? 'rgb(var(--hover))'
												: bandFill(band)
									}
									stroke={c.inRange ? 'rgb(var(--border))' : 'var(--faint)'}
									strokeOpacity={c.inRange ? 0.5 : 0.35}
									strokeWidth={0.8}
									strokeDasharray={c.inRange ? undefined : '2 2'}
								>
									<title>{title}</title>
								</rect>
								{isSelected ? (
									<rect
										x={xOf(c.column) - 2 * ring}
										y={yOf(c.row) - 2 * ring}
										width={CELL + 4 * ring}
										height={CELL + 4 * ring}
										rx={4}
										fill="none"
										stroke="var(--ink)"
										strokeWidth={1.5}
										pointerEvents="none"
									/>
								) : null}
							</g>
						);
					})}
				</svg>
				{/* The interactive layer is HTML, not SVG: a day is a real <button>, so it inherits the
			    shell's focus outline and its accessible name without re-implementing either, and
			    Enter/Space activation comes free. It is absolutely positioned over the svg through
			    the same letterbox transform the hit-testing undoes.
			    Roving tabindex, not 90 tab stops: arrow keys walk the grid (left/right a week,
			    up/down a day) and the whole calendar costs the keyboard exactly one stop. */}
				{onSelectDay ? (
					<div className="pointer-events-none absolute inset-0">
						{inRange.map((c, index) => (
							<button
								type="button"
								key={utcDayKey(c.day)}
								ref={roving.register(index)}
								tabIndex={roving.tabIndexFor(index)}
								onClick={() => onSelectDay(c.day)}
								onFocus={() => roving.setActive(index)}
								onKeyDown={roving.onKeyDown}
								aria-pressed={selected?.day === c.day}
								className="pointer-events-auto absolute rounded-[3px]"
								style={{
									left: offsetX + xOf(c.column) * scale,
									top: offsetY + yOf(c.row) * scale,
									width: CELL * scale,
									height: CELL * scale,
								}}
							>
								<span className="sr-only">
									{`${utcDayKey(c.day)}: ${formatNumber(c.pageviews)} pageviews — narrow the range to this day`}
								</span>
							</button>
						))}
					</div>
				) : null}
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[color:var(--faint)]">
				<span className="inline-flex items-center gap-1">
					<span
						className="inline-block size-2.5 rounded-[2px] border border-dashed"
						style={{ borderColor: 'var(--faint)' }}
						aria-hidden="true"
					/>
					Outside range
				</span>
				<span className="inline-flex items-center gap-1">
					<span
						className="inline-block size-2.5 rounded-[2px]"
						style={{ backgroundColor: 'rgb(var(--hover))' }}
						aria-hidden="true"
					/>
					Zero
				</span>
				<span className="inline-flex items-center gap-1">
					Less
					{[0, 1, 2, 3, 4].map((band) => (
						<span
							key={band}
							className="inline-block size-2.5 rounded-[2px]"
							style={{ backgroundColor: bandFill(band) }}
							aria-hidden="true"
						/>
					))}
					More
				</span>
				<span className="ml-auto tabular-nums">UTC days</span>
			</div>
			{hover ? (
				<ChartTooltip
					x={hover.x}
					y={hover.y}
					containerWidth={boxWidth}
					containerHeight={boxHeight}
				>
					<p className="mb-1 font-semibold">{utcDayKey(hover.datum.day)}</p>
					{hover.datum.inRange ? (
						<TooltipRow
							label="Pageviews"
							value={formatNumber(hover.datum.pageviews)}
							swatch={bandFill(
								Math.max(0, bandOf(hover.datum.pageviews, thresholds)),
							)}
						/>
					) : (
						<p className="text-[color:var(--muted)]">
							Outside the selected range — not queried.
						</p>
					)}
				</ChartTooltip>
			) : null}
			<table className="sr-only">
				<caption>
					Pageviews per UTC day, {formatNumber(total)} across {inRange.length} days
					{busiest && busiest.pageviews > 0
						? `; busiest was ${utcDayKey(busiest.day)} with ${formatNumber(busiest.pageviews)}`
						: ''}
					. Days the grid draws to stay rectangular but the range never covered are listed
					as outside the range, not as zero.
				</caption>
				<thead>
					<tr>
						<th scope="col">Date (UTC)</th>
						<th scope="col">Weekday</th>
						<th scope="col">Pageviews</th>
					</tr>
				</thead>
				<tbody>
					{cells.map((c) => (
						<tr key={utcDayKey(c.day)}>
							<th scope="row">{utcDayKey(c.day)}</th>
							<td>{WEEKDAYS[c.row]}</td>
							<td>
								{c.inRange
									? formatNumber(c.pageviews)
									: 'outside the selected range'}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** Roll a bucketed series (hour or day buckets) up to pageviews per UTC day. */
export function dailyCounts(
	series: readonly { t: number; pageviews: number }[],
): Map<number, number> {
	const out = new Map<number, number>();
	for (const point of series) {
		const day = utcDayStart(point.t);
		out.set(day, (out.get(day) ?? 0) + point.pageviews);
	}
	return out;
}

export { DAY_MS as CALENDAR_DAY_MS };
