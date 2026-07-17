// Anomalies view: renders each detected pageview anomaly as a red/amber banner card with the
// plain-language autopsy summary, the metric, the %-change, and the largest contributor. Empty
// state when nothing is flagged.

import type { Anomaly } from '@facet/shared';
import type { ReactElement } from 'react';
import { useAnomalies } from '../hooks/anomaly.js';
import { cn } from '../lib/cn.js';
import { isAuthError } from '../lib/status.js';
import type { Range } from '../state.js';
import { AuthErrorBanner, CardSkeletons, EmptyState, ErrorState } from './StatusStates.js';

/** Percent change of the anomalous bucket vs. its baseline mean, rounded. */
function pctChange(a: Anomaly): number {
	return a.direction === 'drop'
		? Math.round((1 - a.value / a.baseline_mean) * 100)
		: Math.round((a.value / a.baseline_mean - 1) * 100);
}

function AnomalyCard({ anomaly }: { anomaly: Anomaly }): ReactElement {
	const drop = anomaly.direction === 'drop';
	return (
		<article
			className={cn(
				'rounded-xl border p-5 shadow-sm',
				drop ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50',
			)}
		>
			<div className="mb-2 flex items-center justify-between">
				<span
					className={cn(
						'rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide',
						drop ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700',
					)}
				>
					{anomaly.metric} {anomaly.direction}
				</span>
				<span
					className={cn(
						'text-sm font-semibold tabular-nums',
						drop ? 'text-red-700' : 'text-amber-700',
					)}
				>
					{drop ? '-' : '+'}
					{pctChange(anomaly)}%
				</span>
			</div>
			<p className="text-sm text-neutral-800">{anomaly.summary}</p>
			{anomaly.diagnosis ? (
				<p className="mt-2 text-xs text-neutral-500">
					Contributor: {anomaly.diagnosis.dimension}={anomaly.diagnosis.value} (
					{anomaly.diagnosis.current} vs ~{Math.round(anomaly.diagnosis.baseline_avg)}{' '}
					typical)
				</p>
			) : null}
		</article>
	);
}

export function Anomalies({
	apiKey,
	siteId,
	range,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
}): ReactElement {
	const { data, error, isLoading } = useAnomalies(apiKey, siteId, range);
	const anomalies = data?.anomalies ?? [];

	if (error && isAuthError(error)) {
		return <AuthErrorBanner />;
	}

	if (error) {
		return (
			<ErrorState
				message="Could not load anomalies"
				detail={error instanceof Error ? error.message : null}
			/>
		);
	}

	if (isLoading || !data) {
		return <CardSkeletons count={2} />;
	}

	if (anomalies.length === 0) {
		return <EmptyState title="No anomalies detected" />;
	}

	return (
		<div className="space-y-4">
			{anomalies.map((a) => (
				<AnomalyCard key={`${a.metric}-${a.bucket}`} anomaly={a} />
			))}
		</div>
	);
}
