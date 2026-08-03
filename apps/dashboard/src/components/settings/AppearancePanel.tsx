// Appearance controls: pick the data palette + light/dark mode. A user preference (not admin-gated), so
// it renders above the admin token wall. The UI stays neutral everywhere; the chosen palette colours are
// reserved for data (charts, bars, the map, active filters).

import type { ReactElement } from 'react';
import { cn } from '../../lib/cn.js';
import { type Mode, PALETTES, PALETTE_LABELS, PALETTE_SWATCHES, useTheme } from '../../theme.js';

const MODES: Mode[] = ['dark', 'light'];

export function AppearancePanel(): ReactElement {
	const { palette, mode, setPalette, setMode } = useTheme();
	return (
		<div className="surface rounded-xl p-4">
			<h2 className="font-semibold text-[color:var(--ink)] text-sm">Appearance</h2>
			<p className="mt-1 text-[color:var(--muted)] text-xs">
				The interface stays neutral; the palette colours are used only for data — charts,
				bars, the map, and active filters.
			</p>
			<div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
				{PALETTES.map((p) => (
					<button
						key={p}
						type="button"
						aria-pressed={palette === p}
						onClick={() => setPalette(p)}
						className={cn(
							'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition',
							// `chip-active` is the token-layer selected state; the old accent-400/500/200
							// Tailwind ramp was fixed indigo, so it stayed indigo under every palette
							// this control exists to switch between.
							palette === p
								? 'chip-active'
								: 'border-[color:rgb(var(--border))] text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]',
						)}
					>
						<span className="flex shrink-0 gap-0.5">
							{PALETTE_SWATCHES[p].map((c) => (
								<span
									key={`${p}-${c}`}
									className="size-3.5 rounded-full ring-1 ring-black/10"
									style={{ background: c }}
								/>
							))}
						</span>
						<span className="truncate font-medium">{PALETTE_LABELS[p]}</span>
					</button>
				))}
			</div>
			<div className="mt-3 flex items-center gap-2">
				<span className="font-medium text-[color:var(--muted)] text-xs">Mode</span>
				<div className="inline-flex rounded-lg border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] p-0.5">
					{MODES.map((m) => (
						<button
							key={m}
							type="button"
							aria-pressed={mode === m}
							onClick={() => setMode(m)}
							className={cn(
								'rounded-md border px-3 py-1 font-medium text-sm capitalize transition',
								mode === m
									? 'chip-active'
									: 'border-transparent text-[color:var(--muted)] hover:text-[color:var(--ink)]',
							)}
						>
							{m}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
