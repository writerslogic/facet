// Realtime view: active-visitor proxy over the trailing window, auto-refreshing every 15s and pausing
// while the tab is hidden (see useRealtime). Active visitors are a privacy-safe distinct-hash proxy,
// deduped within the window — no cookies, no persistent id.

import { Radio } from 'lucide-react';
import type { ReactElement } from 'react';
import { useRealtime } from '../hooks/realtime.js';
import { formatNumber } from '../lib/format.js';
import { isAuthError } from '../lib/status.js';
import { AuthErrorBanner, CardSkeletons, EmptyState, ErrorState } from './StatusStates.js';

function Metric({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint?: string;
}): ReactElement {
	return (
		<div className="rounded-2xl border border-[color:rgb(var(--border))] bg-[var(--panel)] p-6 shadow-sm ring-1 ring-[color:rgb(var(--border))]/[0.02]">
			<div className="text-[13px] font-medium text-[color:var(--muted)]" title={hint}>
				{label}
			</div>
			<div className="mt-2 text-4xl font-semibold tracking-tight text-[color:var(--ink)] tabular-nums">
				{value}
			</div>
		</div>
	);
}

export function Realtime({
	apiKey,
	siteId,
}: {
	apiKey: string;
	siteId: string;
}): ReactElement {
	const { data, error, isLoading, isFetching, dataUpdatedAt } = useRealtime(apiKey, siteId);

	if (error && isAuthError(error)) {
		return <AuthErrorBanner />;
	}
	if (error) {
		return (
			<ErrorState
				message="Could not load realtime data"
				detail={error instanceof Error ? error.message : null}
			/>
		);
	}
	if (isLoading || !data) {
		return <CardSkeletons count={2} />;
	}

	const isEmpty = data.visitors === 0 && data.pageviews === 0;
	const updated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '—';

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<span className="inline-flex items-center gap-2 text-sm font-medium text-[color:var(--ink)]">
					<Radio
						className={
							isFetching
								? 'h-4 w-4 animate-pulse text-emerald-500'
								: 'h-4 w-4 text-[color:var(--muted)]'
						}
						aria-hidden="true"
					/>
					Live
				</span>
				<span className="text-xs text-[color:var(--muted)]" aria-live="polite">
					Last updated {updated}
				</span>
			</div>

			{isEmpty ? (
				<EmptyState title="No active visitors right now">
					<span>Visitors from the last 5 minutes will appear here.</span>
				</EmptyState>
			) : (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Metric
						label="Active visitors, last 5 min"
						value={formatNumber(data.visitors)}
						hint="Distinct visitor hashes seen in the last 5 minutes — a privacy-safe proxy, deduped within the window. No cookies, no persistent id."
					/>
					<Metric label="Pageviews, last 5 min" value={formatNumber(data.pageviews)} />
				</div>
			)}

			<p className="text-xs text-[color:var(--muted)]">
				Active visitors is a privacy-safe distinct-hash proxy, deduped within a 5-minute
				window — not a precise count. Auto-refreshes every 15s and pauses while this tab is
				hidden.
			</p>
		</div>
	);
}
