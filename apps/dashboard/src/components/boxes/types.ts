// Shared types for the bento "box" library. Every box lives in its own file under this folder and
// exports a `TileDef`; the registry (lib/tiles) assembles them. Adding a box = add a file + list it in
// `boxes/index.ts`.

import type {
	CountRow,
	CubeCell,
	EngagementSummary,
	SeriesPoint,
	StatsResponse,
} from '@facet/shared';
import type { ReactNode } from 'react';
import type { CubeAxis, CubeFilter, ServerFilter } from '../../lib/cube.js';
import type { TileEmphasis } from '../BentoTile.js';
import type { TimelineAnnotationManager } from '../TimelineNotes.js';
import type { ChartAnnotation } from '../TrafficChart.js';

/** Named grid spans so a slot persists a compact size token rather than raw Tailwind. `kpi` is a short
 * wide band for metric readouts; `sm`/`md` are taller compact tiles; `lg`/`short`/`wide`/`tall`/`xl`
 * suit charts, flows, and lists. */
export type SizeKey = 'kpi' | 'sm' | 'md' | 'lg' | 'wide' | 'tall' | 'xl' | 'short';

/** Everything a box might render, computed once by the board and shared by every box + the overlay. */
export interface TileContext {
	summary: { pageviews: number; visitors: number; events: number };
	series: SeriesPoint[];
	annotations: ChartAnnotation[];
	annotationManager: TimelineAnnotationManager;
	deltas: { pv: number | null; vis: number | null; ev: number | null };
	sparks: { pv: number[]; vis: number[]; ev: number[] };
	sense: (d: number | null) => 'improvement' | 'regression' | 'neutral';
	flowCells: CubeCell[];
	data: StatsResponse;
	engagement: EngagementSummary;
	anyFilter: boolean;
	cubeFilter: CubeFilter;
	serverFilter: ServerFilter;
	toggleServer: (key: keyof ServerFilter) => (value: string) => void;
	dimRows: (axis: CubeAxis, fallback: CountRow[]) => CountRow[];
	dimSelect: (axis: CubeAxis) => ((key: string) => void) | undefined;
}

/** A box's underlying data as a plain grid, for the "view as table" toggle (see + copy the raw numbers). */
export interface TableData {
	columns: string[];
	rows: (string | number)[][];
}

/** A per-instance box configuration: the chosen chart-style variant plus any option values. It rides on
 * the placed Slot (persisted), so the same box wears a different look without becoming a different box. */
export type TileConfigValue = string | boolean;
export interface TileConfig {
	variant?: string;
	[key: string]: TileConfigValue | undefined;
}

/** A selectable chart style for a box; the first entry is the default. */
export interface TileVariant {
	id: string;
	label: string;
}

/** A per-instance customization control surfaced in Customize mode: a `select` (one of `choices`), a
 * `toggle` (boolean), or a `color` (a data-palette accent, `choices` are CSS colours). `key` is the
 * config field it writes. */
export interface TileOption {
	key: string;
	label: string;
	type: 'select' | 'toggle' | 'color';
	choices?: { value: string; label: string }[];
	default: TileConfigValue;
}

/**
 * How much room a tile actually has, and therefore which of its three renderings it draws.
 *
 * IMPORTANT: resolved from the tile's MEASURED pixel box, never from its `SizeKey`. A size key is a
 * grid SPAN, and a span says nothing about height: the same `lg` tile is ~245px tall at rest and was
 * 34px tall while a neighbour was focused, which is how three KPI tiles came to render as empty bars.
 * Measuring the box collapses two problems into one — a deliberately small tile and a tile squeezed by
 * a focused neighbour are the same situation and get the same designed answer.
 *
 * Every box MUST render something legible and finished at all three tiers. `compact` is not a clipped
 * `default`; it is a different, smaller composition (see the per-box notes in each box file).
 */
export type TileDensity = 'compact' | 'default' | 'expanded';

/** A box definition. `render` receives the shared context, the density tier it must draw at, and the
 * resolved per-instance `config` (chart style + options). A box lists the `variants`/`options` it
 * supports; the board persists the user's choices per slot and passes them back here. */
export interface TileDef {
	id: string;
	title: string;
	/** Default board size key (see SIZES). */
	size: SizeKey;
	render: (ctx: TileContext, density: TileDensity, config?: TileConfig) => ReactNode;
	/** Optional header control (e.g. the anomaly legend on the traffic chart). */
	action?: (ctx: TileContext) => ReactNode;
	/** Whether the box offers an expand affordance to focus it in place and reveal `expanded` detail. */
	expandable?: boolean;
	/** The box's raw data as a grid — enables a "view as table" toggle so users can read/copy the numbers.
	 * Receives `config` because a box whose variant selects WHICH data it shows (attribution's model, say)
	 * would otherwise export a different number than the one on screen. */
	table?: (ctx: TileContext, config?: TileConfig) => TableData | null;
	/** The body renders its own title (KPI boxes), so the surrounding tile omits its header. */
	selfLabeled?: boolean;
	/** Surface emphasis — draws the eye to the hero chart/flow and the KPI band. */
	emphasis?: TileEmphasis;
	/** Selectable chart styles for this box (first is the default). Chosen per-instance and persisted. */
	variants?: TileVariant[];
	/** Extra per-instance customization controls (format, scale, colour …) shown in Customize mode. */
	options?: TileOption[];
}
