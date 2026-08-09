// The Traffic flow tile: owns the Sankey's interaction state. The base graph is channel → device;
// clicking a device node expands it to reveal its countries (device → country), clicking a channel or
// country node pins/unpins an isolation highlight. The flow is recomputed from the cube on each change and
// the Sankey tweens between layouts.

import type { CubeCell } from '@facet/shared';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { FLOW_DEVICE_PREFIX, cubeFlow } from '../lib/cube.js';
import { Sankey } from './Sankey.js';

export function FlowTile({
	cells,
	expanded,
}: {
	cells: CubeCell[];
	/** Drill-down: auto-reveal the device → country third column so the focused flow shows the full
	 * channel → device → country path, not just the compact two columns. */
	expanded?: boolean;
}): ReactElement {
	const allDevices = useMemo(
		() =>
			cubeFlow(cells, new Set())
				.nodes.filter((n) => n.id.startsWith(FLOW_DEVICE_PREFIX))
				.map((n) => n.id.slice(FLOW_DEVICE_PREFIX.length)),
		[cells],
	);
	const [expandedDevices, setExpandedDevices] = useState<ReadonlySet<string>>(() => new Set());
	// Focusing the tile fans every device open to its countries; collapsing returns to the compact graph.
	useEffect(() => {
		setExpandedDevices(expanded ? new Set(allDevices) : new Set());
	}, [expanded, allDevices]);
	const [isolated, setIsolated] = useState<string | null>(null);
	const flow = useMemo(() => cubeFlow(cells, expandedDevices), [cells, expandedDevices]);
	// A stale isolated id (the range/segment changed so its node no longer exists) matches nothing in
	// Sankey's connectedTo, dimming EVERY node/ribbon instead of highlighting one — the chart reads as
	// broken until the reader clicks something. Drop the isolation the moment its node disappears.
	useEffect(() => {
		if (isolated !== null && !flow.nodes.some((n) => n.id === isolated)) {
			setIsolated(null);
		}
	}, [flow, isolated]);

	const onNodeClick = (id: string): void => {
		if (id.startsWith(FLOW_DEVICE_PREFIX)) {
			// A device toggles its country expansion.
			const device = id.slice(FLOW_DEVICE_PREFIX.length);
			setExpandedDevices((prev) => {
				const next = new Set(prev);
				if (next.has(device)) next.delete(device);
				else next.add(device);
				return next;
			});
		} else {
			// Any other node pins/unpins an isolation highlight.
			setIsolated((prev) => (prev === id ? null : id));
		}
	};

	if (flow.links.length === 0) {
		return (
			<div className="flex h-full items-center justify-center text-[color:var(--faint)] text-sm">
				No flow data yet
			</div>
		);
	}
	const labelOf = (id: string): string => flow.nodes.find((n) => n.id === id)?.label ?? id;

	return (
		<>
			<Sankey
				nodes={flow.nodes}
				links={flow.links}
				onNodeClick={onNodeClick}
				isolatedId={isolated}
			/>
			{/* The flow was the one chart on the board with no text equivalent — the world map and the
			    retention grid both ship an sr-only table, this shipped a single aria-label reading
			    "Traffic flow diagram" and nothing else. Not data-chrome: these ARE the numbers, so they
			    belong in a copy exactly like the other charts' tables. */}
			<table className="sr-only">
				<caption>Traffic flow, as a table of source to destination visitor counts</caption>
				<thead>
					<tr>
						<th scope="col">From</th>
						<th scope="col">To</th>
						<th scope="col">Visitors</th>
					</tr>
				</thead>
				<tbody>
					{flow.links.map((link) => (
						<tr key={`${link.source}->${link.target}`}>
							<th scope="row">{labelOf(link.source)}</th>
							<td>{labelOf(link.target)}</td>
							<td>{link.value}</td>
						</tr>
					))}
				</tbody>
			</table>
		</>
	);
}
