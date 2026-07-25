// A compact "live" indicator for the Overview: a pulsing dot + the active-visitor-now count from the
// realtime trailing-window proxy. Polls on its own (paused while the tab is hidden) so the board feels
// alive without opening the Realtime tab.

import type { ReactElement } from 'react';
import { useRealtime } from '../hooks/realtime.js';
import { useDashboard } from '../state.js';

export function LivePill(): ReactElement | null {
	const { apiKey, siteId } = useDashboard();
	const { data } = useRealtime(apiKey, siteId);
	if (!data) return null;
	const n = data.visitors;
	return (
		<span
			className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 font-medium text-neutral-300 text-xs shadow-card"
			title={`${n} active visitor${n === 1 ? '' : 's'} in the last few minutes`}
		>
			<span className="relative flex size-2">
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
				<span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
			</span>
			<span className="tabular font-semibold text-neutral-50">{n}</span>
			<span className="text-neutral-400">online</span>
		</span>
	);
}
