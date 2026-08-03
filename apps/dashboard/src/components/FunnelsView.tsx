// Funnels & conversions view: goal conversions plus a per-funnel report with a lightweight funnel
// chart. Reads goals/funnels via the API-key catalog endpoints; no admin token needed. Empty states
// link to Settings, and a deleted/unavailable selection degrades to the prompt without crashing.
//
// Two structural fixes live here: the report query's error was swallowed (a failed report rendered a
// loading skeleton forever), and the funnel picker was a flat row of chips that wraps into a wall
// once a site has more than a handful of funnels — past that it becomes a select.

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useFunnelReport, useFunnels, useGoals } from '../hooks/funnels.js';
import { useFreshness } from '../hooks/stats.js';
import { cn } from '../lib/cn.js';
import { isAuthError } from '../lib/status.js';
import { type Range, previousRange } from '../state.js';
import { Conversions } from './Conversions.js';
import { SegmentNotice } from './CubeFilterBar.js';
import { FunnelChart } from './FunnelChart.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	PendingNotice,
} from './StatusStates.js';

/** Above this many funnels the chip row stops being scannable and becomes a select. */
const CHIP_LIMIT = 6;

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
	// The equal-length preceding window, fetched unconditionally like the Overview's KPI comparison:
	// "40% of visitors reach checkout" only means something next to what it was last period.
	const compare = useFunnelReport(apiKey, siteId, activeFunnelId, previousRange(range));

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
			{/* Neither the conversions endpoint nor the funnel report takes a dimension filter, so an
			    active segment must be declared here rather than implied by the chips above. */}
			<SegmentNotice tab="funnels" />
			<Conversions
				apiKey={apiKey}
				siteId={siteId}
				goals={goals.data?.goals ?? []}
				range={range}
				loading={goals.isLoading}
				error={goals.error}
				onRetry={() => void goals.refetch()}
				retrying={goals.isFetching}
				onOpenSettings={onOpenSettings}
			/>

			<section className="space-y-3">
				{funnels.isLoading ? (
					<CardSkeletons count={1} />
				) : funnels.error ? (
					<ErrorState
						message="Could not load funnels"
						detail={funnels.error instanceof Error ? funnels.error.message : null}
						onRetry={() => void funnels.refetch()}
						retrying={funnels.isFetching}
					/>
				) : funnelList.length > 0 ? (
					<>
						{funnelList.length > CHIP_LIMIT ? (
							<label className="flex flex-wrap items-center gap-2 text-sm">
								<span className="text-[color:var(--muted)]">Funnel</span>
								<select
									className="input min-w-0 max-w-full rounded-md px-2.5 py-1.5 text-sm"
									value={activeFunnelId}
									onChange={(e) => setSelected(e.target.value)}
								>
									{funnelList.map((funnel) => (
										<option key={funnel.id} value={funnel.id}>
											{funnel.name} ({funnel.steps.length} steps)
										</option>
									))}
								</select>
								<span data-chrome className="text-[color:var(--faint)] text-xs">
									{funnelList.length} funnels
								</span>
							</label>
						) : (
							<fieldset className="flex flex-wrap gap-2 border-0 p-0">
								<legend className="sr-only">Select funnel</legend>
								{funnelList.map((funnel) => (
									<button
										key={funnel.id}
										type="button"
										// The funnel name is data the reader may want to copy, not chrome.
										data-selectable
										aria-pressed={funnel.id === activeFunnelId}
										onClick={() => setSelected(funnel.id)}
										className={cn(
											'rounded-md border px-3 py-1.5 text-sm transition-colors',
											funnel.id === activeFunnelId
												? 'chip-active'
												: 'border-[color:rgb(var(--border))] bg-[var(--panel)] text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]',
										)}
									>
										{funnel.name}
									</button>
								))}
							</fieldset>
						)}
						{freshness.data?.pending ? <PendingNotice /> : null}
						{report.error ? (
							isAuthError(report.error) ? (
								<AuthErrorBanner />
							) : (
								<ErrorState
									message="Could not load this funnel's report"
									detail={
										report.error instanceof Error ? report.error.message : null
									}
									onRetry={() => void report.refetch()}
									retrying={report.isFetching}
								/>
							)
						) : report.data ? (
							// The comparison query is allowed to lag or fail: the chart just drops the
							// "vs previous" column rather than blocking the current period on it.
							<FunnelChart report={report.data} previous={compare.data ?? null} />
						) : (
							<CardSkeletons count={1} />
						)}
					</>
				) : (
					<EmptyState
						title="No funnels yet"
						action={
							<button
								type="button"
								onClick={onOpenSettings}
								className="btn-accent rounded-lg px-3.5 py-1.5 text-sm transition"
							>
								Create a funnel in Settings
							</button>
						}
					>
						A funnel is an ordered list of pages or events — say <code>/pricing</code> →{' '}
						<code>/signup</code> → <code>signup_complete</code>. Facet then reports how
						many visitors reached each step and where the largest drop-off is, which is
						the one question a page-by-page breakdown cannot answer.
					</EmptyState>
				)}
			</section>
		</div>
	);
}
