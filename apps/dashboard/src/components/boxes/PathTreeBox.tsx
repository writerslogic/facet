// Path explorer box: one drill position, two ways of drawing it.
//
// The sunburst and the treemap are the same query, the same normalized tree and — critically — the
// same `useDrillPath` stack, so switching representation keeps you exactly where you were. That is
// the reason the drill state lives up here and not inside either chart.
//
// The text equivalent is an sr-only table of the WHOLE tree, not just the visible level: a chart
// whose accessible version only describes what is currently on screen makes a screen-reader user
// operate a drill-down to read numbers a sighted user can see at a glance.

import type { PathTreeResponse } from '@facet/shared';
import { type ReactElement, useMemo } from 'react';
import { type TreeItem, flattenTree, normalizeTree, usePathTree } from '../../hooks/pathTree.js';
import { useDrillPath } from '../../lib/chartInteraction.js';
import { cn } from '../../lib/cn.js';
import type { ServerFilter } from '../../lib/cube.js';
import { formatNumber } from '../../lib/format.js';
import { useDashboard } from '../../state.js';
import { ErrorState, Skeleton } from '../StatusStates.js';
import { ChartEmpty, ChartNote } from '../charts/ChartChrome.js';
import { Sunburst } from '../charts/Sunburst.js';
import { Treemap } from '../charts/Treemap.js';
import type { TileConfig, TileDef } from './types.js';

/** How many levels each chart draws below the focus, by tile state. Expanded gets the tree's full
 * depth; a compact tile stops at three, where the outermost ring is still a few pixels thick. */
const LEVELS = { compact: 3, expanded: 4 } as const;

function levelsOf(config: TileConfig | undefined, expanded: boolean): number {
	const chosen = config?.levels;
	if (typeof chosen === 'string' && chosen !== 'auto') {
		const n = Number.parseInt(chosen, 10);
		if (Number.isFinite(n)) return n;
	}
	return expanded ? LEVELS.expanded : LEVELS.compact;
}

/** The breadcrumb. Chrome as a control, but every path name inside it is data and stays copyable —
 * `button` opts out of selection app-wide, so the label spans opt back in. */
function Breadcrumb({
	path,
	onJump,
}: {
	path: TreeItem[];
	onJump: (index: number) => void;
}): ReactElement {
	return (
		<nav
			data-chrome
			aria-label="Path tree position"
			className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px]"
		>
			{path.map((item, i) => {
				const last = i === path.length - 1;
				return (
					<span key={item.key} className="flex items-center gap-1">
						{/* A chevron, not a slash: the crumbs carry whole paths, so a slash
						    separator would read as one more URL segment. */}
						{i > 0 ? (
							<span aria-hidden="true" className="text-[color:var(--faint)]">
								›
							</span>
						) : null}
						{last ? (
							<span
								aria-current="page"
								data-selectable
								className="max-w-[14rem] truncate font-semibold text-[color:var(--ink)]"
							>
								{item.path}
							</span>
						) : (
							<button
								type="button"
								onClick={() => onJump(i)}
								className={cn(
									'max-w-[10rem] truncate rounded px-1 text-[color:var(--muted)]',
									'transition-colors hover:text-[color:var(--ink)]',
								)}
							>
								<span data-selectable>{item.path}</span>
							</button>
						)}
					</span>
				);
			})}
		</nav>
	);
}

/**
 * The chart, breadcrumb and text equivalent over an already-fetched tree. Split out from the fetching
 * wrapper so the whole interaction is testable without a network, a provider or a fake clock.
 */
export function PathTreeExplorer({
	tree,
	variant,
	levels,
}: {
	tree: PathTreeResponse;
	variant: string;
	levels: number;
}): ReactElement {
	// Memoized on the response: React Query's structural sharing hands back the same object when a
	// refetch changed nothing, which is what keeps a background refresh from resetting the drill.
	const root = useMemo(() => normalizeTree(tree.root), [tree]);
	const drill = useDrillPath(root);
	const rows = useMemo(() => flattenTree(root), [root]);

	const shared = {
		focus: drill.current,
		minCount: tree.min_count,
		onDrill: drill.drillTo,
		onBack: drill.back,
		canGoBack: drill.depth > 0,
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-1.5">
			<Breadcrumb path={drill.path} onJump={drill.jumpTo} />
			<div className="min-h-0 flex-1">
				{variant === 'treemap' ? (
					<Treemap {...shared} levels={levels} />
				) : (
					<Sunburst {...shared} rings={levels} />
				)}
			</div>
			<ChartNote>
				{`${formatNumber(tree.paths)} paths · depth ${tree.max_depth} · subtrees under ${tree.min_count} pageviews grouped as Other`}
			</ChartNote>
			{/* These ARE the numbers, so — like the flow, map and retention tables — they are selectable
			    and not marked as chrome. The whole tree, at every depth, in reading order. */}
			<table className="sr-only">
				<caption>
					{`Pages by URL prefix: ${formatNumber(root.value)} pageviews across ${formatNumber(tree.paths)} paths, nested ${tree.max_depth} levels deep. Subtrees under ${tree.min_count} pageviews are grouped as "Other".`}
				</caption>
				<thead>
					<tr>
						<th scope="col">Path</th>
						<th scope="col">Level</th>
						<th scope="col">Pageviews</th>
						<th scope="col">Share of parent</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(({ item, share }) => (
						<tr key={item.key}>
							<th scope="row">
								{item.kind === 'other'
									? `Other pages under ${item.path.replace(/\/[^/]*$/, '') || '/'}`
									: item.kind === 'self'
										? `${item.path} (this page only)`
										: item.path}
							</th>
							<td>{item.depth}</td>
							<td>{formatNumber(item.value)}</td>
							<td>{`${Math.round(share * 100)}%`}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function PathTreeTile({
	serverFilter,
	expanded,
	config,
}: {
	serverFilter: ServerFilter;
	expanded: boolean;
	config?: TileConfig;
}): ReactElement {
	const { apiKey, siteId, range } = useDashboard();
	const { data, isLoading, error } = usePathTree(apiKey, siteId, range, serverFilter);

	if (error) return <ErrorState message="Could not load the path tree." />;
	// Skeleton, not a "Loading…" sentence: every other box on the board shows the shape it is about to
	// fill, and a tile that swaps a line of prose for a chart re-lays out under the reader.
	if (isLoading || !data) return <Skeleton className="h-full w-full" />;
	// A response without a tree is a protocol failure, not an empty chart — and reading through it
	// throws inside render, which unmounts the whole dashboard rather than this one tile. Say what
	// went wrong instead.
	if (!data.root || !Array.isArray(data.root.children)) {
		return <ErrorState message="The path tree response was not in the expected shape." />;
	}
	if (data.root.children.length === 0) {
		return (
			<ChartEmpty reason="range">
				No pageviews were recorded in this window, so there is no URL tree to walk.
			</ChartEmpty>
		);
	}
	return (
		<PathTreeExplorer
			tree={data}
			variant={typeof config?.variant === 'string' ? config.variant : 'sunburst'}
			levels={levelsOf(config, expanded)}
		/>
	);
}

export const pathTreeBox: TileDef = {
	id: 'path-tree',
	title: 'Path explorer',
	size: 'tall',
	expandable: true,
	variants: [
		{ id: 'sunburst', label: 'Sunburst' },
		{ id: 'treemap', label: 'Treemap' },
	],
	options: [
		{
			key: 'levels',
			label: 'Levels',
			type: 'select',
			choices: [
				{ value: 'auto', label: 'Auto' },
				{ value: '2', label: '2' },
				{ value: '3', label: '3' },
				{ value: '4', label: '4' },
			],
			default: 'auto',
		},
	],
	render: (ctx, expanded, config) => (
		<PathTreeTile
			serverFilter={ctx.serverFilter}
			expanded={Boolean(expanded)}
			config={config}
		/>
	),
};
