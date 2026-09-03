// Persisted board types and layout constants. The registry is metadata-only so reading or editing a
// layout never imports optional JSX implementations; TileRuntime resolves those separately.

import {
	type SizeKey,
	TILE_CATALOG,
	type TileConfig,
	type TileMetadata,
} from '../features/overview/catalog.js';
import { randomId } from './id.js';

export type {
	SizeKey,
	TileConfig,
	TileMetadata,
	TileOption,
	TileVariant,
} from '../features/overview/catalog.js';
export type { TileContext } from '../components/boxes/types.js';

/** Grid spans per size at the two column counts, expressed as a token so a slot persists a compact size
 * rather than raw Tailwind. The default layout packs into the desktop grid with no holes. */
export const SIZES: Record<SizeKey, string> = {
	kpi: 'col-span-1 lg:col-span-2 lg:row-span-1',
	sm: 'col-span-1 lg:col-span-1 lg:row-span-2',
	md: 'col-span-1 lg:col-span-2 lg:row-span-2',
	lg: 'col-span-2 lg:col-span-3 lg:row-span-2',
	short: 'col-span-2 lg:col-span-3 lg:row-span-1',
	tall: 'col-span-2 lg:col-span-3 lg:row-span-3',
	// Three rows, not two: a full-width band is chosen for charts that need a long time axis, and at
	// two rows the plot was squeezed out from under its own legend (see MultiLine's compact rule).
	wide: 'col-span-2 lg:col-span-6 lg:row-span-3',
	xl: 'col-span-2 row-span-2 lg:col-span-4 lg:row-span-3',
};

/** Human labels for the resize control (never surface the raw token). */
export const SIZE_LABEL: Record<SizeKey, string> = {
	kpi: 'Metric',
	sm: 'Small',
	md: 'Medium',
	lg: 'Large',
	short: 'Short',
	wide: 'Wide',
	tall: 'Tall',
	xl: 'Hero',
};

/** Resize cycles are kind-aware so a box only steps through sizes that suit it — and every shipped
 * default size stays reachable.
 *
 * `short` is one grid row, which after the row floor became a real minimum is ~26px of content box.
 * That is a fine band for a metric readout and is not a size any chart or ranked list can draw in, so
 * it belongs to the KPI cycle only. A chart's smallest reachable size is `md` (2 × 2), and every chart
 * on the board is verified to degrade legibly at exactly that size. */
export const KPI_CYCLE: SizeKey[] = ['kpi', 'short', 'sm', 'md', 'lg'];
export const CHART_CYCLE: SizeKey[] = ['md', 'lg', 'wide', 'tall', 'xl'];

/** Metadata-only catalog. Optional component modules are not reachable from this import graph. */
export const TILE_REGISTRY = TILE_CATALOG;

/** A placed box: a stable identity (`uid`, so reorder preserves per-box state and never remounts the
 * chart), which box it shows, and its grid size. */
export interface Slot {
	uid: string;
	tileId: string;
	size: SizeKey;
	/** Per-instance chart-style + option overrides (see TileConfig); absent = the box's declared defaults. */
	config?: TileConfig;
}

/** A fresh unique slot id. Prefixed with the box id purely to stay debuggable. */
export function newSlotUid(tileId: string): string {
	return `${tileId}-${randomId()}`;
}

/** Merge a slot's stored config over the box's declared defaults: `variant` defaults to the first
 * declared variant, each option to its `default`. Always returns a fully-populated config a box can read
 * without re-checking for undefined; an unknown stored variant falls back to the default. */
export function resolveTileConfig(def: TileMetadata, config?: TileConfig): TileConfig {
	const resolved: TileConfig = {};
	if (def.variants && def.variants.length > 0) {
		const chosen =
			config?.variant && def.variants.some((v) => v.id === config.variant)
				? config.variant
				: def.variants[0]?.id;
		if (chosen) resolved.variant = chosen;
	}
	for (const opt of def.options ?? []) {
		const stored = config?.[opt.key];
		resolved[opt.key] = stored !== undefined ? stored : opt.default;
	}
	return resolved;
}

/** The at-a-glance board a new site opens on. It answers the six essential questions without a scroll:
 * overall traffic, the three headline counts, and the leading pages and countries. Every other box
 * remains in TILE_REGISTRY as an insight users can intentionally add. Default uids are stable. */
export const DEFAULT_LAYOUT: Slot[] = [
	{ uid: 'traffic', tileId: 'traffic', size: 'xl' },
	{ uid: 'pageviews', tileId: 'pageviews', size: 'kpi' },
	{ uid: 'visitors', tileId: 'visitors', size: 'kpi' },
	{ uid: 'events', tileId: 'events', size: 'kpi' },
	{ uid: 'pages', tileId: 'pages', size: 'lg' },
	{ uid: 'countries', tileId: 'countries', size: 'lg' },
];
