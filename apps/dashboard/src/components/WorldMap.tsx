// Choropleth world map for the Countries tile: each country shape is shaded by its share of traffic
// (brighter = more, since the board is dark), on the prism ramp indigo→fuchsia. Hovering reads out the
// country; clicking cross-filters the board. Dependency-free — geometry is the `WORLD` module, which is
// ~128 kB of path data and so is fetched on demand (see `useWorldGeo`) rather than in the main bundle.

import type { CountRow } from '@facet/shared';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { type Movement, formatNumber } from '../lib/format.js';
import { useSize } from '../lib/useSize.js';
import type { CountryShape } from '../lib/worldGeo.js';
import { useThemeColors } from '../theme.js';
import { DeltaBadge } from './Delta.js';
import { Skeleton } from './StatusStates.js';
import { type Rgb, hexToRgb } from './charts/ramp.js';

interface WorldGeo {
	shapes: CountryShape[];
	viewBox: string;
}

// Module-level cache + in-flight promise: the tile remounts on expand/collapse, tab switches and board
// re-layouts, and none of those should re-await (or re-request) the geometry.
let geoCache: WorldGeo | null = null;
let geoPending: Promise<WorldGeo> | null = null;

/** Loads the country path data on first render of a map. `null` while in flight, `'error'` if the chunk
 * could not be fetched — the tile stays useful in both cases (see the render below). */
function useWorldGeo(): WorldGeo | null | 'error' {
	const [geo, setGeo] = useState<WorldGeo | null | 'error'>(geoCache);
	useEffect(() => {
		if (geoCache) return;
		let cancelled = false;
		geoPending ??= import('../lib/worldGeo.js').then((m) => ({
			shapes: m.WORLD,
			viewBox: m.WORLD_VIEWBOX,
		}));
		geoPending
			.then((loaded) => {
				geoCache = loaded;
				if (!cancelled) setGeo(loaded);
			})
			.catch(() => {
				// Clear the cached rejection so a later mount can retry (e.g. once the network is back).
				geoPending = null;
				if (!cancelled) setGeo('error');
			});
		return () => {
			cancelled = true;
		};
	}, []);
	return geo;
}

/** One list row's height and the gap under it, in px — `py-1` + a 20px line + `gap-0.5`. */
const ROW_H = 28;
const ROW_GAP = 2;

// Intensity ramp between the active palette's low (`lo`) and hot (`hi`) data colours; opacity rises with
// intensity so a hot country glows and a cold one only tints. `t` is 0–1 (log-scaled share).
function ramp(t: number, lo: Rgb, hi: Rgb): string {
	const clamp = Math.max(0, Math.min(1, t));
	const mix = (a: number, b: number): number => Math.round(a + (b - a) * clamp);
	// Floor raised so a country with ANY traffic reads as lit rather than a barely-there tint.
	const op = (0.45 + 0.55 * clamp).toFixed(2);
	return `rgba(${mix(lo[0], hi[0])},${mix(lo[1], hi[1])},${mix(lo[2], hi[2])},${op})`;
}

export function WorldMap({
	rows,
	onSelect,
	activeKey,
	deltas,
}: {
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	/** Per-country movement vs the preceding period, keyed by ISO code. A shape cannot carry a delta
	 * (the choropleth already spends its one visual channel on volume), so it rides in the corner
	 * readout and the top-five list — the two places the map states a number. */
	deltas?: ReadonlyMap<string, Movement>;
}): ReactElement {
	const [hover, setHover] = useState<string | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const size = useSize(wrapRef);
	const geo = useWorldGeo();
	const colors = useThemeColors();
	const lo = hexToRgb(colors.d1);
	const hi = hexToRgb(colors.d3);
	const [ir, ig, ib] = hexToRgb(colors.ink);
	// 0.06 left the landmasses invisible on the dark board — the map read as an empty rectangle.
	const noData = `rgba(${ir},${ig},${ib},0.14)`;
	const { byIso, total, logMax } = useMemo(() => {
		const m = new Map<string, number>();
		let tot = 0;
		let mx = 0;
		for (const r of rows) {
			const iso = r.key.toUpperCase();
			m.set(iso, (m.get(iso) ?? 0) + r.count);
			tot += r.count;
			mx = Math.max(mx, r.count);
		}
		return { byIso: m, total: tot, logMax: Math.log(mx + 1) || 1 };
	}, [rows]);

	// Re-keyed to match `byIso`: the API's country keys are compared case-insensitively everywhere
	// else on this map, and a delta that silently missed on case would look like "no comparison".
	const deltaByIso = useMemo(() => {
		if (!deltas) return null;
		const m = new Map<string, Movement>();
		for (const [key, movement] of deltas) m.set(key.toUpperCase(), movement);
		return m;
	}, [deltas]);

	const active = activeKey?.toUpperCase() ?? null;
	const readIso = hover ?? active;
	const readCount = readIso ? (byIso.get(readIso) ?? 0) : 0;

	// How many rows the tile can actually hold. Five were drawn unconditionally into a `justify-center`
	// column, so on a two-row tile the list overflowed its 130px box by 16px and the browser clipped
	// the first and last rows through the middle — which reads as a rendering fault, not as a top-5.
	// The bar ranks by height, so a short list is a correct answer; a sliced one never is.
	const fit = size.height > 0 ? Math.max(1, Math.floor((size.height + ROW_GAP) / ROW_H)) : 5;
	const topRows = rows.slice(0, Math.min(5, fit));
	const maxTop = topRows.reduce((m, r) => Math.max(m, r.count), 0);

	return (
		<div ref={wrapRef} className="flex h-full w-full gap-3">
			{/* The map pane is `flex-1`, so its box is fixed by the tile, not by its contents — the
			    placeholder and the error state occupy exactly the same space as the loaded map and
			    neighbouring tiles never move. */}
			<div className="relative min-h-0 min-w-0 flex-1">
				{geo === null ? (
					<Skeleton className="h-full w-full" />
				) : geo === 'error' ? (
					<div className="flex h-full w-full items-center justify-center p-3">
						<p className="alert-warn rounded-md px-2.5 py-1.5 text-center text-[11px]">
							Map graphics unavailable — country totals shown at right.
						</p>
					</div>
				) : (
					<svg
						viewBox={geo.viewBox}
						preserveAspectRatio="xMidYMid meet"
						className="h-full w-full"
						role="img"
						aria-label="Traffic by country"
					>
						{geo.shapes.map((c) => {
							const count = byIso.get(c.iso) ?? 0;
							const has = count > 0;
							const t = has ? Math.log(count + 1) / logMax : 0;
							const isActive = active === c.iso;
							const dim = hover !== null && hover !== c.iso && has;
							return (
								// biome-ignore lint/a11y/useKeyWithClickEvents: 175 focusable country paths would wreck keyboard nav; cross-filter here is a pointer enhancement
								<path
									key={c.iso}
									d={c.d}
									fill={has ? ramp(t, lo, hi) : noData}
									stroke={isActive ? colors.d3 : 'rgb(var(--bg))'}
									strokeWidth={isActive ? 0.8 : 0.3}
									className={has && onSelect ? 'cursor-pointer' : undefined}
									style={{
										opacity: dim ? 0.72 : 1,
										transition: 'opacity .15s, fill .3s',
									}}
									onMouseEnter={() => setHover(c.iso)}
									onMouseLeave={() => setHover((h) => (h === c.iso ? null : h))}
									onClick={has && onSelect ? () => onSelect(c.iso) : undefined}
								/>
							);
						})}
					</svg>
				)}
				{/* Corner readout — the hovered (or active-filtered) country's numbers. */}
				<div className="pointer-events-none absolute top-1 left-1 flex items-baseline gap-1.5 rounded-md bg-black/40 px-2 py-1 backdrop-blur-sm">
					{readIso && readCount > 0 ? (
						<>
							<span className="font-mono font-semibold text-[12px] text-[color:var(--ink)]">
								{readIso}
							</span>
							<span className="tabular font-semibold text-[13px] text-[color:var(--ink)]">
								{formatNumber(readCount)}
							</span>
							<span className="text-[11px] text-[color:var(--muted)] tabular-nums">
								{total > 0 ? Math.round((readCount / total) * 100) : 0}%
							</span>
							<DeltaBadge
								movement={readIso ? deltaByIso?.get(readIso) : undefined}
								variant="text"
								size="sm"
							/>
						</>
					) : (
						<span className="text-[11px] text-[color:var(--muted)] uppercase tracking-[0.1em]">
							{byIso.size} regions
						</span>
					)}
				</div>
			</div>
			{/* Top-5 list beside the map (immediate quantitative read), hidden when the tile is too narrow. */}
			{/* w-40, not w-36: at 144px a five-figure count plus its delta badge ran past the row's own
			    `overflow-hidden` and lost the "%" off the end of every percentage. */}
			<ul className="flex min-h-0 w-40 shrink-0 flex-col justify-center gap-0.5 overflow-hidden @max-[26rem]/tile:hidden">
				{topRows.map((row, i) => {
					const iso = row.key.toUpperCase();
					const isActive = active === iso;
					const width = maxTop > 0 ? (row.count / maxTop) * 100 : 0;
					return (
						<li key={row.key}>
							<button
								type="button"
								aria-pressed={isActive}
								onClick={onSelect ? () => onSelect(iso) : undefined}
								onMouseEnter={() => setHover(iso)}
								onMouseLeave={() => setHover((h) => (h === iso ? null : h))}
								className={cn(
									'group relative flex w-full items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-left',
									isActive
										? 'bg-[color:rgb(var(--hover))]'
										: 'hover:bg-[color:rgb(var(--hover))]',
								)}
							>
								<span
									className="absolute inset-y-0.5 left-0 rounded-sm"
									style={{
										width: `${width}%`,
										background: `color-mix(in srgb, ${i < 3 ? PRISM[i] : 'var(--faint)'} 22%, transparent)`,
									}}
									aria-hidden="true"
								/>
								<span className="relative z-10 w-3 shrink-0 text-right text-[10px] text-[color:var(--faint)] tabular-nums">
									{i + 1}
								</span>
								<span className="relative z-10 w-6 shrink-0 font-medium font-mono text-[12px] text-[color:var(--ink)]">
									{iso}
								</span>
								<span className="relative z-10 ml-auto font-semibold text-[12px] text-[color:var(--ink)] tabular-nums">
									{formatNumber(row.count)}
								</span>
								<span className="relative z-10 shrink-0">
									<DeltaBadge
										movement={deltaByIso?.get(iso)}
										variant="text"
										size="sm"
									/>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			{/* The map is role="img" with a single label, and the visible Top-5 beside it both truncates
			    at five and is hidden outright on a narrow tile — so at small sizes the country numbers
			    had no text form at all. Same sr-only table shape as the retention grid and the traffic
			    flow, and selectable like them, because these ARE the numbers, not chrome. */}
			<table className="sr-only">
				<caption>
					Traffic by country: {byIso.size} countries, {formatNumber(total)} pageviews in
					total.
				</caption>
				<thead>
					<tr>
						<th scope="col">Country</th>
						<th scope="col">Pageviews</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.key}>
							<th scope="row">{row.key.toUpperCase()}</th>
							<td>{formatNumber(row.count)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const PRISM = ['var(--c1)', 'var(--c2)', 'var(--c3)'] as const;
