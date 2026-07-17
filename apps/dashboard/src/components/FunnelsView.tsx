// Funnels & conversions view: goal conversions plus a per-funnel report with a lightweight funnel
// chart. Reads goals/funnels via the API-key catalog endpoints; no admin token needed. Empty states
// link to Settings, and a deleted/unavailable selection degrades to the prompt without crashing.

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useFunnelReport, useFunnels, useGoals } from '../hooks/funnels.js';
import { useFreshness } from '../hooks/stats.js';
import { cn } from '../lib/cn.js';
import { isAuthError } from '../lib/status.js';
import type { Range } from '../state.js';
import { Conversions } from './Conversions.js';
import { FunnelChart } from './FunnelChart.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	PendingNotice,
} from './StatusStates.js';

export function FunnelsView({
	apiKey,
	siteId,
	range,
	onOpenSettings,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
	onOpenSettings: () => void;
}): ReactElement {
	const goals = useGoals(apiKey, siteId);
	const funnels = useFunnels(apiKey, siteId);
	const freshness = useFreshness(apiKey, siteId, range);
	const [selected, setSelected] = useState<string | null>(null);

	const funnelList = funnels.data?.funnels ?? [];
	// Keep the chosen funnel while it exists; fall back to the first when it's deleted/unavailable.
	const selectedExists = selected != null && funnelList.some((f) => f.id === selected);
	const activeFunnelId = selectedExists ? selected : (funnelList[0]?.id ?? '');
	const report = useFunnelReport(apiKey, siteId, activeFunnelId, range);

	useEffect(() => {
		if (selected != null && !selectedExists) setSelected(null);
	}, [selected, selectedExists]);

	if (
		(goals.error && isAuthError(goals.error)) ||
		(funnels.error && isAuthError(funnels.error))
	) {
		return <AuthErrorBanner />;
	}

	return (
		<div className="space-y-6">
			<Conversions
				apiKey={apiKey}
				siteId={siteId}
				goals={goals.data?.goals ?? []}
				range={range}
				loading={goals.isLoading}
				error={goals.error}
				onOpenSettings={onOpenSettings}
			/>

			<section className="space-y-3">
				{funnels.isLoading ? (
					<CardSkeletons count={1} />
				) : funnels.error ? (
					<ErrorState
						message="Could not load funnels"
						detail={funnels.error instanceof Error ? funnels.error.message : null}
					/>
				) : funnelList.length > 0 ? (
					<>
						<fieldset className="flex flex-wrap gap-2 border-0 p-0">
							<legend className="sr-only">Select funnel</legend>
							{funnelList.map((funnel) => (
								<button
									key={funnel.id}
									type="button"
									aria-pressed={funnel.id === activeFunnelId}
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
						</fieldset>
						{freshness.data?.pending ? <PendingNotice /> : null}
						{report.data ? (
							<FunnelChart report={report.data} />
						) : (
							<CardSkeletons count={1} />
						)}
					</>
				) : (
					<EmptyState title="No funnels yet">
						<button
							type="button"
							onClick={onOpenSettings}
							className="font-medium text-sky-600 underline hover:text-sky-800"
						>
							Create a funnel in Settings
						</button>
					</EmptyState>
				)}
			</section>
		</div>
	);
}
