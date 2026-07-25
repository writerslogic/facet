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

/** A box definition. `render` receives the shared context and whether it is drawing inside the
 * drill-down overlay (so lists can show more rows, the chart can breathe, etc.). */
export interface TileDef {
	id: string;
	title: string;
	/** Default board size key (see SIZES). */
	size: SizeKey;
	render: (ctx: TileContext, expanded?: boolean) => ReactNode;
	/** Optional header control (e.g. the anomaly legend on the traffic chart). */
	action?: (ctx: TileContext) => ReactNode;
	/** Whether the box offers an expand affordance to focus it in place and reveal `expanded` detail. */
	expandable?: boolean;
	/** The body renders its own title (KPI boxes), so the surrounding tile omits its header. */
	selfLabeled?: boolean;
	/** Surface emphasis — draws the eye to the hero chart/flow and the KPI band. */
	emphasis?: TileEmphasis;
}
