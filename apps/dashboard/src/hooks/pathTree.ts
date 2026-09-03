// The URL-prefix tree (`GET /api/stats/path-tree`) — the read plus the one normalization every
// hierarchy chart on the board shares.
//
// WHY A NORMALIZED SHAPE: the wire format is deliberately minimal (`pageviews` is the SUBTREE total,
// `self` is the traffic that stopped on that exact path, `other: true` marks a synthetic fold node).
// A sunburst and a treemap both need the same three derivations from that — sibling ordering, an
// explicit slice for `self` so children never over-state their share, and a hard "this is not a page,
// do not drill into it" flag on `other`. Deriving those twice is how two charts of the same data end
// up disagreeing, so they are derived once, here.

import type { PathTreeNode, PathTreeResponse } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api.js';
import type { ServerFilter } from '../lib/cube.js';
import { siteQueryKey } from '../lib/queryKeys.js';
import type { Range } from '../state.js';

/**
 * What a node is, which decides how it is drawn and whether it can be drilled:
 * - `page`   a real URL prefix,
 * - `other`  the synthetic aggregate a parent's below-the-floor subtrees were folded into,
 * - `self`   the slice standing for `node.self` — traffic that stopped on this exact path.
 */
export type TreeKind = 'page' | 'other' | 'self';

/** A node ready to lay out: values already summed, children already ordered, drillability decided. */
export interface TreeItem {
	/** Unique within the tree; also the tween identity, so an arc/rect keeps its shape across a drill. */
	key: string;
	/** The URL prefix this stands for. Real data — always copyable, never chrome. */
	path: string;
	/** Short display label (one segment, or the aggregate's name). */
	label: string;
	/** Subtree pageviews — what area and angle encode. */
	value: number;
	/** 0 at the root. A `self` slice sits one level below the node it belongs to. */
	depth: number;
	kind: TreeKind;
	/** Ordered: real children by pageviews desc, then `other`, then `self`. Sums exactly to `value`. */
	children: TreeItem[];
	/** True only for a real page with real children beneath it. */
	drillable: boolean;
}

/** Suffix that keeps a node's `self` slice from colliding with the node's own key. */
const SELF_SUFFIX = '#self';

/** Label for a `self` slice — it is the same URL as its parent, so it must not read as a new page. */
const SELF_LABEL = 'This page';

function toItem(node: PathTreeNode): TreeItem {
	// An `other` node is an aggregate of subtrees that never cleared the anonymity floor. There is no
	// page behind it and no detail to reveal, so it is a leaf and it is never drillable.
	if (node.other) {
		return {
			key: node.path,
			path: node.path,
			label: 'Other',
			value: node.pageviews,
			depth: node.depth,
			kind: 'other',
			children: [],
			drillable: false,
		};
	}

	const real: TreeItem[] = [];
	const folded: TreeItem[] = [];
	for (const child of node.children) (child.other ? folded : real).push(toItem(child));
	// Ties broken on key so a re-fetch of identical data cannot reshuffle the chart under the cursor.
	real.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
	const children = [...real, ...folded];

	// `pageviews - self` is what the children hold. A node with BOTH its own traffic and children
	// therefore needs an explicit slice for the traffic that stopped here — without it the children
	// would be scaled to fill their parent and every one of them would over-state its share.
	if (children.length > 0 && node.self > 0) {
		children.push({
			key: `${node.path}${SELF_SUFFIX}`,
			path: node.path,
			label: SELF_LABEL,
			value: node.self,
			depth: node.depth + 1,
			kind: 'self',
			children: [],
			drillable: false,
		});
	}

	return {
		key: node.path,
		path: node.path,
		label: node.segment || node.path || '/',
		value: node.pageviews,
		depth: node.depth,
		kind: 'page',
		children,
		// A node whose only child is its own `self` slice has nothing to reveal: drilling into it
		// would show one full-circle slice labelled "This page".
		drillable: children.some((c) => c.kind !== 'self'),
	};
}

/** Normalize a wire tree into the layout-ready shape. Pure — the charts and the tests share it. */
export function normalizeTree(root: PathTreeNode): TreeItem {
	return toItem(root);
}

/** Sum of a node's children. Equals `value` for a well-formed tree; layouts divide by it, so they
 * use this rather than `value` and stay correct even if a future server change stops it balancing. */
export function childrenTotal(item: TreeItem): number {
	return item.children.reduce((sum, c) => sum + c.value, 0);
}

/** One row of the text equivalent: a node plus its share of the parent it sits under. */
export interface TreeRow {
	item: TreeItem;
	/** 0..1 of the immediate parent's subtree total; 1 for the root. */
	share: number;
}

/** Depth-first walk, parents before children — the reading order of the sr-only table. */
export function flattenTree(root: TreeItem): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (item: TreeItem, share: number): void => {
		rows.push({ item, share });
		const total = childrenTotal(item) || 1;
		for (const child of item.children) walk(child, child.value / total);
	};
	walk(root, 1);
	return rows;
}

/** The sentence a tooltip, an aria-label and the sr-only table all use for a node, so a screen-reader
 * user and a sighted user are told the same thing about an aggregate. */
export function describeItem(item: TreeItem, minCount: number): string {
	if (item.kind === 'other') {
		return `Other: smaller paths grouped together, each under ${minCount} pageviews`;
	}
	if (item.kind === 'self') return `${item.path} — views that stopped on this exact path`;
	return item.path;
}

/**
 * The path-tree read for a site/range, scoped by the board's active path/referrer filter so this box
 * agrees with every other box on what is being looked at.
 */
export function usePathTree(
	apiKey: string,
	siteId: string,
	range: Range,
	filter: ServerFilter = {},
) {
	return useQuery({
		queryKey: siteQueryKey('path-tree', siteId, range, filter),
		queryFn: () => {
			const params = new URLSearchParams({
				site_id: siteId,
				start: String(range.start),
				end: String(range.end),
			});
			if (filter.path) params.set('path', filter.path);
			if (filter.referrer) params.set('referrer', filter.referrer);
			return apiFetch<PathTreeResponse>(`/api/stats/path-tree?${params}`, apiKey);
		},
		enabled: Boolean(siteId) && range.end > range.start,
		// Keep the current tree on screen while a range/filter change loads, but never show the
		// previous SITE's tree under the new label.
		placeholderData: (prev, prevQuery) =>
			prevQuery?.queryKey[1] === siteId ? prev : undefined,
	});
}
