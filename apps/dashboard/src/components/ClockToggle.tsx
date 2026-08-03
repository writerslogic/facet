// The header control that states which clock the dashboard is in, and switches it.
//
// This is the "say it once, unmistakably" half of the timezone decision (see lib/datetime.ts). Every
// absolute timestamp in the app already carries its own zone suffix; this is the one place that says
// it as a standing fact rather than a suffix, and the one place it can be changed.
//
// It is a two-state toggle, not a menu: there are exactly two answers a dashboard over a UTC-only
// server can honestly give — the reader's own timezone, or the server's.

import { Globe } from 'lucide-react';
import type { ReactElement } from 'react';
import { clockLabel, clockZone, toggleClockMode, useClockMode } from '../lib/datetime.js';

export function ClockToggle(): ReactElement {
	const mode = useClockMode();
	const label = clockLabel();
	const zone = clockZone();
	const other = mode === 'utc' ? 'your own timezone' : 'UTC';

	return (
		<button
			type="button"
			data-chrome
			// A switch, not a toggle button: it has two named states and `aria-checked` is what
			// carries "UTC is on" to a screen reader without inventing a second label.
			role="switch"
			aria-checked={mode === 'utc'}
			onClick={() => toggleClockMode()}
			title={
				mode === 'utc'
					? `All times are shown in UTC, matching the server. Switch to your own timezone (${zone}).`
					: `All times are shown in your timezone (${zone}). Switch to UTC, which is what the server and your logs use.`
			}
			aria-label={`Times shown in ${mode === 'utc' ? 'UTC' : zone}. Switch to ${other}.`}
			className="btn-ghost inline-flex items-center gap-1.5 rounded-lg border border-[color:rgb(var(--border))] px-2.5 py-1.5 font-medium text-sm transition"
		>
			<Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
			{/* "Times" is NOT dropped at narrow widths. A lone "PDT" beside a globe icon is a puzzle,
			    and this control's whole job is to state the clock unmistakably — the label costs four
			    characters on a row the header has already wrapped to by then. */}
			<span className="text-[color:var(--faint)]">Times</span>
			<span className="text-[color:var(--ink)] tabular-nums">{label}</span>
		</button>
	);
}
