// The box registry + board layout constants. Each box's implementation lives in its own file under
// `components/boxes/`; this module assembles them into the keyed registry the board renders, and owns the
// grid-size vocabulary + the shipped default layout. Adding a box = add a file in `boxes/` and list it in
// `boxes/index.ts` — no change here.

import { BOXES } from '../components/boxes/index.js';
import type { SizeKey, TileConfig, TileDef } from '../components/boxes/types.js';
import { randomId } from './id.js';

export type {
	SizeKey,
	TileConfig,
	TileContext,
	TileDef,
	TileOption,
	TileVariant,
} from '../components/boxes/types.js';

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

/** The catalog, keyed by box id — assembled from the box library. */
export const TILE_REGISTRY: Record<string, TileDef> = Object.fromEntries(
	BOXES.map((box) => [box.id, box]),
);

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
export function resolveTileConfig(def: TileDef, config?: TileConfig): TileConfig {
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

/** The out-of-the-box board — reproduces the shipped layout. Users mutate a copy in localStorage.
 * Default uids are the box ids (each box appears once), which keeps them stable across reloads. */
/**
 * The board a new site opens on. Packed against the 6-column `lg` grid with no holes: every row's
 * spans sum to 6, so a tile never leaves a gap its neighbour cannot fill.
 *
 *   traffic(4) + three kpi(2) stacked   rows 1-3
 *   pages(3) + countries(3)             rows 4-5
 *   trends(6)                           rows 6-8
 *   flow(3) + path-tree(3)              rows 9-11    — both `tall`, so they pair exactly
 *   timing(3) + segments(3)             rows 12-14   — both `tall`, for the same reason
 *   browsers(3) + networks(3)           rows 15-16
 *
 * ORDER IS THE SCROLL BUDGET. With a real row floor the board is taller than one viewport, so the
 * question stops being "does it fit" and becomes "what is above the fold". The two ranked breakdowns
 * sit directly under the hero rather than eight rows down: "which pages, which countries" is the
 * question a reader arrives with, and it should not cost a scroll to answer.
 *
 * `timing` and `segments` are `tall` rather than `lg` because both are area-hungry — a radial dial and
 * a packed field each need a roughly square plot, and at two rows they were a dot and a scatter of
 * specks respectively.
 *
 * `distribution` is deliberately NOT here despite being registered: it suppresses below 25 sessions,
 * so a brand-new site's first ever view of Facet would lead with a tile explaining why it is empty.
 * It is one click away under "Add tile" once a site has traffic worth describing.
 */
export const DEFAULT_LAYOUT: Slot[] = [
	{ uid: 'traffic', tileId: 'traffic', size: 'xl' },
	{ uid: 'pageviews', tileId: 'pageviews', size: 'kpi' },
	{ uid: 'visitors', tileId: 'visitors', size: 'kpi' },
	{ uid: 'events', tileId: 'events', size: 'kpi' },
	{ uid: 'pages', tileId: 'pages', size: 'lg' },
	{ uid: 'countries', tileId: 'countries', size: 'lg' },
	{ uid: 'trends', tileId: 'trends', size: 'wide' },
	{ uid: 'flow', tileId: 'flow', size: 'tall' },
	{ uid: 'path-tree', tileId: 'path-tree', size: 'tall' },
	{ uid: 'timing', tileId: 'timing', size: 'tall' },
	{ uid: 'segments', tileId: 'segments', size: 'tall' },
	{ uid: 'browsers', tileId: 'browsers', size: 'lg' },
	{ uid: 'networks', tileId: 'networks', size: 'lg' },
];
