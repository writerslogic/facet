// The box registry + board layout constants. Each box's implementation lives in its own file under
// `components/boxes/`; this module assembles them into the keyed registry the board renders, and owns the
// grid-size vocabulary + the shipped default layout. Adding a box = add a file in `boxes/` and list it in
// `boxes/index.ts` — no change here.

import { BOXES } from '../components/boxes/index.js';
import type { SizeKey, TileDef } from '../components/boxes/types.js';

export type {
	SizeKey,
	TileContext,
	TileDef,
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
	wide: 'col-span-2 lg:col-span-6 lg:row-span-2',
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
 * default size stays reachable (KPIs keep their short band; charts keep short/wide/tall). */
export const KPI_CYCLE: SizeKey[] = ['kpi', 'sm', 'md', 'lg'];
export const CHART_CYCLE: SizeKey[] = ['md', 'lg', 'short', 'wide', 'tall', 'xl'];

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
}

/** A fresh unique slot id. Prefixed with the box id purely to stay debuggable. */
export function newSlotUid(tileId: string): string {
	const rand = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
	return `${tileId}-${rand}`;
}

/** The out-of-the-box board — reproduces the shipped layout. Users mutate a copy in localStorage.
 * Default uids are the box ids (each box appears once), which keeps them stable across reloads. */
export const DEFAULT_LAYOUT: Slot[] = [
	{ uid: 'traffic', tileId: 'traffic', size: 'xl' },
	{ uid: 'pageviews', tileId: 'pageviews', size: 'kpi' },
	{ uid: 'visitors', tileId: 'visitors', size: 'kpi' },
	{ uid: 'events', tileId: 'events', size: 'kpi' },
	{ uid: 'flow', tileId: 'flow', size: 'tall' },
	{ uid: 'pages', tileId: 'pages', size: 'lg' },
	{ uid: 'countries', tileId: 'countries', size: 'lg' },
];
