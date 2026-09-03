// Shared implementation contracts for the bento "box" library. Layout metadata and registration
// live in the independent Overview catalog and runtime groups.

import type {
	CountRow,
	CubeCell,
	EngagementSummary,
	SeriesPoint,
	StatsResponse,
} from '@facet/shared';
import type { ReactNode } from 'react';
import type { TileConfig } from '../../features/overview/catalog.js';
import type { CubeAxis, CubeFilter, ServerFilter } from '../../lib/cube.js';
import type { TimelineAnnotationManager } from '../TimelineNotes.js';
import type { ChartAnnotation } from '../TrafficChart.js';

export type {
	SizeKey,
	TileConfig,
	TileOption,
	TileVariant,
} from '../../features/overview/catalog.js';

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

export type { TileConfigValue } from '../../features/overview/catalog.js';

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

/** JSX implementation only. Persisted/layout metadata lives in the independent Overview catalog. */
export interface TileDef {
	render: (ctx: TileContext, density: TileDensity, config?: TileConfig) => ReactNode;
	/** Optional header control (e.g. the anomaly legend on the traffic chart). */
	action?: (ctx: TileContext) => ReactNode;
	/** The box's raw data as a grid — enables a "view as table" toggle so users can read/copy the numbers.
	 * Receives `config` because a box whose variant selects WHICH data it shows (attribution's model, say)
	 * would otherwise export a different number than the one on screen. */
	table?: (ctx: TileContext, config?: TileConfig) => TableData | null;
}
