// Choropleth world map for the Countries tile: each country shape is shaded by its share of traffic
// (brighter = more, since the board is dark), on the prism ramp indigo→fuchsia. Hovering reads out the
// country; clicking cross-filters the board. Dependency-free — geometry is the inlined `WORLD` module.

import type { CountRow } from '@facet/shared';
import { type ReactElement, useMemo, useState } from 'react';
import { cn } from '../lib/cn.js';
import { formatNumber } from '../lib/format.js';
import { WORLD, WORLD_VIEWBOX } from '../lib/worldGeo.js';
import { useThemeColors } from '../theme.js';

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
	const h = hex.replace('#', '').trim();
	const full =
		h.length === 3
			? h
					.split('')
					.map((c) => c + c)
					.join('')
			: h;
	const n = Number.parseInt(full || '818cf8', 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Intensity ramp between the active palette's low (`lo`) and hot (`hi`) data colours; opacity rises with
// intensity so a hot country glows and a cold one only tints. `t` is 0–1 (log-scaled share).
function ramp(t: number, lo: Rgb, hi: Rgb): string {
	const clamp = Math.max(0, Math.min(1, t));
	const mix = (a: number, b: number): number => Math.round(a + (b - a) * clamp);
	const op = (0.32 + 0.6 * clamp).toFixed(2);
	return `rgba(${mix(lo[0], hi[0])},${mix(lo[1], hi[1])},${mix(lo[2], hi[2])},${op})`;
}

export function WorldMap({
	rows,
	onSelect,
	activeKey,
}: {
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
}): ReactElement {
	const [hover, setHover] = useState<string | null>(null);
	const colors = useThemeColors();
	const lo = hexToRgb(colors.d1);
	const hi = hexToRgb(colors.d3);
	const [ir, ig, ib] = hexToRgb(colors.ink);
	const noData = `rgba(${ir},${ig},${ib},0.06)`;
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

	const active = activeKey?.toUpperCase() ?? null;
	const readIso = hover ?? active;
	const readCount = readIso ? (byIso.get(readIso) ?? 0) : 0;

	const topFive = rows.slice(0, 5);
	const maxTop = topFive.reduce((m, r) => Math.max(m, r.count), 0);

	return (
		<div className="flex h-full w-full gap-3">
			<div className="relative min-h-0 min-w-0 flex-1">
				<svg
					viewBox={WORLD_VIEWBOX}
					preserveAspectRatio="xMidYMid meet"
					className="h-full w-full"
					role="img"
					aria-label="Traffic by country"
				>
					{WORLD.map((c) => {
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
						</>
					) : (
						<span className="text-[11px] text-[color:var(--muted)] uppercase tracking-[0.1em]">
							{byIso.size} regions
						</span>
					)}
				</div>
			</div>
			{/* Top-5 list beside the map (immediate quantitative read), hidden when the tile is too narrow. */}
			<ul className="flex w-36 shrink-0 flex-col justify-center gap-0.5 @max-[26rem]/tile:hidden">
				{topFive.map((row, i) => {
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
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

const PRISM = ['var(--c1)', 'var(--c2)', 'var(--c3)'] as const;
