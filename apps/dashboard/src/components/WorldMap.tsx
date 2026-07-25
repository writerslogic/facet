// Choropleth world map for the Countries tile: each country shape is shaded by its share of traffic
// (brighter = more, since the board is dark), on the prism ramp indigo→fuchsia. Hovering reads out the
// country; clicking cross-filters the board. Dependency-free — geometry is the inlined `WORLD` module.

import type { CountRow } from '@facet/shared';
import { type ReactElement, useMemo, useState } from 'react';
import { formatNumber } from '../lib/format.js';
import { WORLD, WORLD_VIEWBOX } from '../lib/worldGeo.js';

// Two-stop prism ramp (indigo → violet → fuchsia) with opacity rising by intensity, so a hot country
// glows and a cold one only tints. `t` is 0–1 (log-scaled share).
function ramp(t: number): string {
	const clamp = Math.max(0, Math.min(1, t));
	const low = clamp < 0.5;
	const [ar, ag, ab] = low ? [99, 102, 241] : [139, 92, 246];
	const [br, bg, bb] = low ? [139, 92, 246] : [217, 70, 239];
	const f = low ? clamp / 0.5 : (clamp - 0.5) / 0.5;
	const mix = (x: number, y: number): number => Math.round(x + (y - x) * f);
	const op = (0.32 + 0.6 * clamp).toFixed(2);
	return `rgba(${mix(ar, br)},${mix(ag, bg)},${mix(ab, bb)},${op})`;
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

	return (
		<div className="relative h-full w-full">
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
							fill={has ? ramp(t) : 'rgba(255,255,255,0.035)'}
							stroke={isActive ? '#e879f9' : 'rgba(5,4,12,0.55)'}
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
						<span className="font-mono font-semibold text-[12px] text-neutral-100">
							{readIso}
						</span>
						<span className="tabular font-semibold text-[13px] text-neutral-50">
							{formatNumber(readCount)}
						</span>
						<span className="text-[11px] text-neutral-400 tabular-nums">
							{total > 0 ? Math.round((readCount / total) * 100) : 0}%
						</span>
					</>
				) : (
					<span className="text-[11px] text-neutral-400 uppercase tracking-[0.1em]">
						{byIso.size} regions
					</span>
				)}
			</div>
		</div>
	);
}
