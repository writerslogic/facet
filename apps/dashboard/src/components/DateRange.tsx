// Date-range preset switcher. Selecting a preset updates the store and URL, which recomputes
// the derived { start, end } window consumed by the stats query.

import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';
import { RANGE_PRESETS, type RangePreset, useDashboard } from '../state.js';

const LABELS: Record<RangePreset, string> = {
	'24h': '24h',
	'7d': '7d',
	'30d': '30d',
	'90d': '90d',
};

export function DateRange(): ReactElement {
	const { preset, setPreset } = useDashboard();

	return (
		<div className="inline-flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
			{RANGE_PRESETS.map((option) => (
				<button
					key={option}
					type="button"
					aria-pressed={preset === option}
					onClick={() => setPreset(option)}
					className={cn(
						'rounded-md px-3 py-1 text-sm font-medium transition',
						preset === option
							? 'bg-white text-neutral-900 shadow-sm'
							: 'text-neutral-500 hover:text-neutral-900',
					)}
				>
					{LABELS[option]}
				</button>
			))}
		</div>
	);
}
