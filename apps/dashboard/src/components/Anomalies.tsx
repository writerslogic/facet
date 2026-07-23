// Anomalies view: each detected anomaly is a card with a labeled severity badge (text + color +
// icon), a plain-language "why flagged" explanation, the contributing segment, and a local dismiss
// action scoped by a stable `${site}:${metric}:${bucket}` id so dismissing one never hides another.

import type { Anomaly } from '@facet/shared';
import { AlertOctagon, AlertTriangle, Info, Search, ShieldCheck, X } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useAnomalies } from '../hooks/anomaly.js';
import { useCheckpoint } from '../hooks/transparency.js';
import {
	type Severity,
	anomalyId,
	dismissAnomaly,
	isDismissed,
	severityFor,
} from '../lib/anomaly.js';
import { cn } from '../lib/cn.js';
import type { CubeFilter } from '../lib/cube.js';
import { isAuthError } from '../lib/status.js';
import type { Range } from '../state.js';
import { AuthErrorBanner, CardSkeletons, EmptyState, ErrorState } from './StatusStates.js';
import { VerifiedMetric } from './VerifiedMetric.js';

const SEVERITY_META: Record<
	Severity,
	{ label: string; badge: string; card: string; icon: typeof AlertOctagon }
> = {
	critical: {
		label: 'Critical',
		badge: 'bg-red-100 text-red-800',
		card: 'border-red-200 bg-red-50/60',
		icon: AlertOctagon,
	},
	high: {
		label: 'High',
		badge: 'bg-amber-100 text-amber-800',
		card: 'border-amber-200 bg-amber-50/60',
		icon: AlertTriangle,
	},
	moderate: {
		label: 'Moderate',
		badge: 'bg-sky-100 text-sky-800',
		card: 'border-sky-200 bg-sky-50/50',
		icon: Info,
	},
};

function pctChange(a: Anomaly): number {
	return a.direction === 'drop'
		? Math.round((1 - a.value / a.baseline_mean) * 100)
		: Math.round((a.value / a.baseline_mean - 1) * 100);
}

/** Human label for an anomaly, shown in its proof drawer header. */
function anomalyLabel(a: Anomaly): string {
	return `${a.metric} ${a.direction} · ${new Date(a.bucket).toUTCString()}`;
}

/** The Provenance switch: turns on the transparency-log attestation overlay for the anomaly list. */
function ProvenanceToggle({
	on,
	onToggle,
}: {
	on: boolean;
	onToggle: () => void;
}): ReactElement {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			onClick={onToggle}
			className={cn(
				'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
				on
					? 'border-emerald-300 bg-emerald-50 text-emerald-700'
					: 'border-neutral-200 bg-white text-neutral-500 hover:text-neutral-900',
			)}
		>
			<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
			Provenance
			<span
				className={cn(
					'rounded px-1 text-[10px] font-semibold',
					on ? 'bg-emerald-600 text-white' : 'bg-neutral-200 text-neutral-600',
				)}
			>
				{on ? 'ON' : 'OFF'}
			</span>
		</button>
	);
}

function AnomalyCard({
	anomaly,
	id,
	onDismiss,
	onInvestigate,
}: {
	anomaly: Anomaly;
	id: string;
	onDismiss: (id: string) => void;
	onInvestigate?: (filter: CubeFilter) => void;
}): ReactElement {
	const severity = severityFor(anomaly.z);
	const meta = SEVERITY_META[severity];
	const Icon = meta.icon;
	const drop = anomaly.direction === 'drop';

	return (
		<article className={cn('rounded-2xl border p-5 shadow-sm', meta.card)}>
			<div className="mb-2 flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
							meta.badge,
						)}
					>
						<Icon className="h-3.5 w-3.5" aria-hidden="true" />
						{meta.label}
					</span>
					<span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
						{anomaly.metric} {anomaly.direction}
					</span>
				</div>
				<div className="flex items-center gap-3">
					<span className="text-sm font-semibold tabular-nums text-neutral-700">
						{drop ? '-' : '+'}
						{pctChange(anomaly)}%
					</span>
					<button
						type="button"
						onClick={() => onDismiss(id)}
						aria-label="Dismiss anomaly"
						className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-white/60 hover:text-neutral-700"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
			</div>
			<p className="text-sm text-neutral-800">{anomaly.summary}</p>
			{anomaly.diagnosis ? (
				<p className="mt-2 text-xs text-neutral-500">
					Why flagged: largest contributor {anomaly.diagnosis.dimension}=
					{anomaly.diagnosis.value} ({anomaly.diagnosis.current} vs ~
					{Math.round(anomaly.diagnosis.baseline_avg)} typical), z-score{' '}
					{anomaly.z.toFixed(1)}.
				</p>
			) : (
				<p className="mt-2 text-xs text-neutral-500">
					Why flagged: {anomaly.value} vs ~{Math.round(anomaly.baseline_mean)} typical,
					z-score {anomaly.z.toFixed(1)}.
				</p>
			)}
			{onInvestigate && anomaly.diagnosis ? (
				<button
					type="button"
					onClick={() =>
						onInvestigate({
							[anomaly.diagnosis?.dimension as string]: anomaly.diagnosis?.value,
						})
					}
					className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white/70 px-2.5 py-1 text-xs font-medium text-neutral-700 transition hover:border-accent-400 hover:text-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
				>
					<Search className="h-3.5 w-3.5" aria-hidden="true" />
					Investigate {anomaly.diagnosis.dimension} = {anomaly.diagnosis.value}
				</button>
			) : null}
		</article>
	);
}

export function Anomalies({
	apiKey,
	siteId,
	range,
	onInvestigate,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
	/** Focus the Overview on an anomaly's diagnosed segment (device/country/channel). */
	onInvestigate?: (filter: CubeFilter) => void;
}): ReactElement {
	const { data, error, isLoading } = useAnomalies(apiKey, siteId, range);
	// Dismissed ids are seeded from storage and updated locally so a dismiss re-filters without a refetch.
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
	// Provenance mode overlays the transparency-log attestation on each anomaly. The checkpoint is fetched
	// lazily — only while the mode is on — so the default view never pays for it. `isLoading` is tracked so
	// the in-flight frame reads "checking…" rather than the false "no log" claim.
	const [provenance, setProvenance] = useState(false);
	const { data: checkpoint, isLoading: checkpointLoading } = useCheckpoint(
		provenance ? apiKey : '',
	);

	const visible = useMemo(() => {
		const all = data?.anomalies ?? [];
		return all
			.map((a) => ({ anomaly: a, id: anomalyId(siteId, a) }))
			.filter((entry) => !isDismissed(entry.id) && !dismissed.has(entry.id));
	}, [data, siteId, dismissed]);

	function onDismiss(id: string): void {
		dismissAnomaly(id);
		setDismissed((prev) => new Set(prev).add(id));
	}

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

	return (
		<div className="space-y-4">
			<div className="flex justify-end">
				<ProvenanceToggle on={provenance} onToggle={() => setProvenance((v) => !v)} />
			</div>
			{provenance ? (
				checkpointLoading ? (
					<p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
						Checking for a transparency log…
					</p>
				) : checkpoint ? (
					<p className="rounded-lg border border-emerald-200/70 bg-emerald-50/50 px-3 py-2 text-xs text-emerald-800">
						This deployment commits its metrics to a signed transparency log — open a
						Verified badge to inspect its current signed tree head.
					</p>
				) : (
					<p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
						This deployment doesn't publish a transparency log, so these anomalies can't
						be cryptographically verified.
					</p>
				)
			) : null}
			{visible.length === 0 ? (
				<EmptyState title="No anomalies detected" />
			) : (
				// Only the card list is a live region, so toggling Provenance doesn't announce a flood of
				// card content. Under Provenance every card is wrapped in VerifiedMetric (stable identity;
				// the badge appears when the shared checkpoint resolves) rather than swapping element types.
				<div className="space-y-4" aria-live="polite">
					{visible.map((entry) =>
						provenance ? (
							<VerifiedMetric key={entry.id} label={anomalyLabel(entry.anomaly)}>
								<AnomalyCard
									id={entry.id}
									anomaly={entry.anomaly}
									onDismiss={onDismiss}
									onInvestigate={onInvestigate}
								/>
							</VerifiedMetric>
						) : (
							<AnomalyCard
								key={entry.id}
								id={entry.id}
								anomaly={entry.anomaly}
								onDismiss={onDismiss}
								onInvestigate={onInvestigate}
							/>
						),
					)}
				</div>
			)}
		</div>
	);
}
