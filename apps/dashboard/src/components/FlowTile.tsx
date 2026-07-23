// The Traffic flow tile: owns the Sankey's interaction state. The base graph is channel → device;
// clicking a device node expands it to reveal its countries (device → country), clicking a channel or
// country node pins/unpins an isolation highlight. The flow is recomputed from the cube on each change and
// the Sankey tweens between layouts.

import type { CubeCell } from '@facet/shared';
import { type ReactElement, useMemo, useState } from 'react';
import { FLOW_DEVICE_PREFIX, cubeFlow } from '../lib/cube.js';
import { Sankey } from './Sankey.js';

export function FlowTile({
	cells,
	dark,
}: {
	cells: CubeCell[];
	dark?: boolean;
}): ReactElement {
	const [expandedDevices, setExpandedDevices] = useState<ReadonlySet<string>>(() => new Set());
	const [isolated, setIsolated] = useState<string | null>(null);
	const flow = useMemo(() => cubeFlow(cells, expandedDevices), [cells, expandedDevices]);

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
			<div className="flex h-full items-center justify-center text-neutral-400 text-sm">
				No flow data yet
			</div>
		);
	}
	return (
		<Sankey
			nodes={flow.nodes}
			links={flow.links}
			onNodeClick={onNodeClick}
			isolatedId={isolated}
			dark={dark}
		/>
	);
}
