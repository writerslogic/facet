// Devices box: ranked list, click a device to cross-filter the board (client-side cube dim).
//
// Rows are cube-derived (pageviews); the comparison is the server's device breakdown in BOTH windows,
// so both sides of every percentage count the same thing. See ChannelsBox for the full reasoning.
//
// Inspecting a row composes that device from the cube's other axes (country, channel) with no round
// trip at all — and reports visitors as an upper bound, because distinct counts do not sum across cells.
//
// COMPACT diverges from the shared leader-row deliberately. The device axis is bounded where pages and
// countries are not: `request-meta.ts` derives only mobile/tablet/desktop, and the cube adds a fourth
// key, `unknown`, for imported events that carried no user-agent (the `top_devices` fallback excludes
// those, so it lists three). Four keys still fit one line — and the split is the number this box exists
// to give, which a "+2 more" tail would hide. Drawn as a 100% segmented bar plus a clickable legend.

import type { CountRow } from '@facet/shared';
import type { ReactElement } from 'react';
import { cn } from '../../lib/cn.js';
import { ChartEmpty } from '../charts/ChartChrome.js';
import { drillSpec } from './drill.js';
import { ListBody, accentOf, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

/** Hue per device key, keyed rather than positional so the bar and legend keep the same colours when
 * mobile overtakes desktop. `unknown` is keyed for the same reason: the cube emits it, so it is a
 * ranked value like any other, not spillover. Anything else falls back to the prism cycle. */
const DEVICE_COLOR: Record<string, string> = {
	desktop: 'var(--c1)',
	mobile: 'var(--c2)',
	tablet: 'var(--c3)',
	unknown: 'var(--c6)',
};

const EXTRA_COLORS = ['var(--d1)', 'var(--d2)', 'var(--d3)', 'var(--c4)', 'var(--c5)'] as const;

function sliceColor(key: string, index: number, accent?: string): string {
	if (accent) {
		return `color-mix(in srgb, ${accent} ${Math.max(28, 100 - index * 22)}%, transparent)`;
	}
	return DEVICE_COLOR[key] ?? EXTRA_COLORS[index % EXTRA_COLORS.length] ?? 'var(--c1)';
}

/**
 * The `compact` rendering: the device mix, whole, in two rows.
 *
 * A 100% segmented bar and a legend of every key with its share. Deliberately drops the
 * absolute counts and the movement badges: at this height they cost a third row, and both are one
 * resize away in the default rendering. The bar is decorative (the legend states every number it
 * encodes), so it is hidden from assistive tech and the legend buttons carry the accessible names.
 */
function DeviceMix({
	rows,
	onSelect,
	activeKey,
	accent,
}: {
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	accent?: string;
}): ReactElement {
	let total = 0;
	for (const r of rows) total += r.count;
	if (total <= 0) return <ChartEmpty reason="range" compact />;

	const slices = rows.map((r, i) => ({
		key: r.key,
		color: sliceColor(r.key, i, accent),
		pct: (r.count / total) * 100,
	}));

	return (
		<div className="flex h-full min-h-0 flex-col justify-center gap-1.5">
			<div
				aria-hidden="true"
				className="flex h-1.5 w-full shrink-0 gap-px overflow-hidden rounded-full bg-[color:rgb(var(--hover))]"
			>
				{slices.map((s) => (
					<span
						key={s.key}
						className="h-full transition-[flex-grow] duration-500"
						style={{
							flexGrow: s.pct,
							flexBasis: 0,
							background: s.color,
							opacity: activeKey && activeKey !== s.key ? 0.4 : 1,
						}}
					/>
				))}
			</div>
			{/* IMPORTANT: nowrap. A second legend row costs height the compact tier does not have, so
			    items truncate instead. The clip that enforces it would also swallow the board's focus
			    ring (2px outline at 2px offset), which the cancelling padding/margin lets through. */}
			<ul className="-mx-1 -my-1 flex min-w-0 shrink-0 flex-nowrap items-center gap-x-1 overflow-hidden px-1 py-1">
				{slices.map((s) => {
					const active = s.key === activeKey;
					const pct = Math.round(s.pct);
					const inner = (
						<>
							<span
								className="size-2 shrink-0 rounded-[2px]"
								style={{ background: s.color }}
								aria-hidden="true"
							/>
							{/* Below ~13rem the words no longer fit beside the swatches and
							    percentages; the button's aria-label still names the key. */}
							<span className="min-w-0 truncate @max-[13rem]/tile:hidden">
								{s.key}
							</span>
							<span className="shrink-0 font-semibold text-[color:var(--ink)] tabular-nums">
								{pct}%
							</span>
						</>
					);
					const cls =
						'flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-[color:var(--muted)]';
					return (
						<li key={s.key} className="min-w-0">
							{onSelect ? (
								<button
									type="button"
									onClick={() => onSelect(s.key)}
									aria-pressed={active}
									aria-label={`${s.key}, ${pct}%`}
									className={cn(
										cls,
										'transition-colors hover:bg-[color:rgb(var(--hover))]',
										active &&
											'bg-[color:rgb(var(--hover))] text-[color:var(--chip-ink)]',
									)}
								>
									{inner}
								</button>
							) : (
								<span className={cls}>{inner}</span>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export const devicesBox: TileDef = {
	table: (ctx) => rowsTable('Device', ctx.dimRows('device', ctx.data.top_devices)),
	render: (ctx, density, config) => {
		const rows = ctx.dimRows('device', ctx.data.top_devices);
		if (density === 'compact') {
			return (
				<DeviceMix
					rows={rows}
					onSelect={ctx.dimSelect('device')}
					activeKey={ctx.cubeFilter.device}
					accent={accentOf(config)}
				/>
			);
		}
		return (
			<ListBody
				title="Devices"
				rows={rows}
				onSelect={ctx.dimSelect('device')}
				activeKey={ctx.cubeFilter.device}
				density={density}
				config={config}
				compare={{
					current: ctx.data.top_devices ?? [],
					select: (p) => p.top_devices,
				}}
				drill={drillSpec(ctx, 'device')}
			/>
		);
	},
};
