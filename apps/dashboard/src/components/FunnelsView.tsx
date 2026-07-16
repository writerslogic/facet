// Funnels & conversions view: goal conversions plus a per-funnel report with a lightweight funnel
// chart. Reads goals/funnels via the API-key catalog endpoints; no admin token needed.

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useFunnelReport, useFunnels, useGoals } from '../hooks/funnels.js';
import { cn } from '../lib/cn.js';
import type { Range } from '../state.js';
import { Conversions } from './Conversions.js';
import { FunnelChart } from './FunnelChart.js';

export function FunnelsView({
	apiKey,
	siteId,
	range,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
}): ReactElement {
	const goals = useGoals(apiKey, siteId);
	const funnels = useFunnels(apiKey, siteId);
	const [selected, setSelected] = useState<string | null>(null);
	const activeFunnelId = selected ?? funnels.data?.funnels[0]?.id ?? '';
	const report = useFunnelReport(apiKey, siteId, activeFunnelId, range);

	return (
		<div className="space-y-6">
			<Conversions
				apiKey={apiKey}
				siteId={siteId}
				goals={goals.data?.goals ?? []}
				range={range}
			/>

			<section className="space-y-3">
				{funnels.data && funnels.data.funnels.length > 0 ? (
					<div className="flex flex-wrap gap-2">
						{funnels.data.funnels.map((funnel) => (
							<button
								key={funnel.id}
								type="button"
								onClick={() => setSelected(funnel.id)}
								className={cn(
									'rounded-md border px-3 py-1.5 text-sm transition-colors',
									funnel.id === activeFunnelId
										? 'border-sky-500 bg-sky-50 text-sky-700'
										: 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50',
								)}
							>
								{funnel.name}
							</button>
						))}
					</div>
				) : (
					<p className="rounded-xl border border-neutral-200 bg-white p-5 text-center text-sm text-neutral-400 shadow-sm">
						No funnels defined. Create one with the admin API.
					</p>
				)}
				{report.data ? <FunnelChart report={report.data} /> : null}
			</section>
		</div>
	);
}
