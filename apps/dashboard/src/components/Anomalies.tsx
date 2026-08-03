// Anomalies view: each detected anomaly is a card with a labeled severity badge (text + color +
// icon), the hour it covers, a direction (drop/spike) stated in words and an arrow, a plain-language
// "why flagged" explanation that translates the z-score, the contributing segment, and a local
// dismiss action scoped by a stable `${site}:${metric}:${bucket}` id so dismissing one never hides
// another. Dismissals are reversible — immediately (Undo) and later (the Dismissed section) — because
// an irreversible hide on a page that usually holds a single card is a trap.

import type { Anomaly } from '@facet/shared';
import {
	AlertOctagon,
	AlertTriangle,
	Info,
	RotateCcw,
	Search,
	ShieldCheck,
	TrendingDown,
	TrendingUp,
	X,
} from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useAnomalies } from '../hooks/anomaly.js';
import { useCheckpoint } from '../hooks/transparency.js';
import {
	type Severity,
	anomalyId,
	changePct,
	compareAnomalies,
	describeBucket,
	dismissAnomaly,
	explainZ,
	loadDismissed,
	restoreAnomaly,
	severityFor,
	summaryLine,
} from '../lib/anomaly.js';
import { cn } from '../lib/cn.js';
import type { CubeFilter } from '../lib/cube.js';
import { formatStamp, useClockMode } from '../lib/datetime.js';
import { formatNumber } from '../lib/format.js';
import { isAuthError } from '../lib/status.js';
import type { Range } from '../state.js';
import { SegmentNotice } from './CubeFilterBar.js';
import { AuthErrorBanner, CardSkeletons, EmptyState, ErrorState } from './StatusStates.js';
import { VerifiedMetric } from './VerifiedMetric.js';

const SEVERITY_META: Record<
	Severity,
	{ label: string; badge: string; card: string; icon: typeof AlertOctagon }
> = {
	critical: {
		label: 'Critical',
		badge: 'badge-neg',
		card: 'alert-error',
		icon: AlertOctagon,
	},
	high: {
		label: 'High',
		badge: 'badge-warn',
		card: 'alert-warn',
		icon: AlertTriangle,
	},
	moderate: {
		label: 'Moderate',
		badge: 'badge-info',
		card: 'alert-info',
		icon: Info,
	},
};

interface Entry {
	anomaly: Anomaly;
	id: string;
	severity: Severity;
}

/** Human label for an anomaly, shown in its proof drawer header. */
function anomalyLabel(a: Anomaly): string {
	return `${a.metric} ${a.direction} · ${formatStamp(a.bucket)}`;
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
					? 'badge-pos'
					: 'border-[color:rgb(var(--border))] bg-[var(--panel)] text-[color:var(--muted)] hover:text-[color:var(--ink)]',
			)}
		>
			<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
			Provenance
			<span
				className={cn(
					'rounded px-1 text-[10px] font-semibold',
					on ? 'badge-pos' : 'badge-neutral',
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
	severity,
	now,
	onDismiss,
	onInvestigate,
}: {
	anomaly: Anomaly;
	id: string;
	severity: Severity;
	now: number;
	onDismiss: (id: string) => void;
	onInvestigate?: (filter: CubeFilter) => void;
}): ReactElement {
	const meta = SEVERITY_META[severity];
	const Icon = meta.icon;
	const drop = anomaly.direction === 'drop';
	// Direction is never carried by color alone: an arrow icon and the word "fell"/"rose" say it too.
	const DirectionIcon = drop ? TrendingDown : TrendingUp;
	const pct = changePct(anomaly);
	const when = describeBucket(anomaly.bucket, now);
	const { diagnosis } = anomaly;

	return (
		<article className={cn('rounded-2xl border p-5 shadow-sm', meta.card)}>
			<div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<span
						className={cn(
							'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
							meta.badge,
						)}
					>
						<Icon className="h-3.5 w-3.5" aria-hidden="true" />
						{meta.label}
					</span>
					<span className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-[color:var(--muted)]">
						<DirectionIcon className="h-3.5 w-3.5" aria-hidden="true" />
						{anomaly.metric} {anomaly.direction}
					</span>
				</div>
				<div className="flex items-center gap-3">
					<span className="text-sm font-semibold tabular-nums text-[color:var(--ink)]">
						{pct === null ? (
							// No baseline to divide by: state the counts instead of a bogus percent.
							<>{formatNumber(anomaly.value)} vs 0 typical</>
						) : (
							<>
								{drop ? 'fell ' : 'rose '}
								{pct}%
							</>
						)}
					</span>
					<button
						type="button"
						onClick={() => onDismiss(id)}
						aria-label="Dismiss anomaly"
						className="rounded-md p-1 text-[color:var(--muted)] transition-colors hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
			</div>
			{/* When it happened was previously only visible inside the proof drawer. */}
			<p className="mb-2 text-xs text-[color:var(--faint)]">
				<time dateTime={when.iso}>{when.absolute}</time> · {when.relative}
			</p>
			<p className="text-sm text-[color:var(--ink)]">{anomaly.summary}</p>
			<p className="mt-2 text-xs text-[color:var(--muted)]">
				Why flagged: {formatNumber(anomaly.value)} vs ~
				{formatNumber(Math.round(anomaly.baseline_mean))} typical for this hour — a swing of{' '}
				{explainZ(anomaly.z)} (z-score {anomaly.z.toFixed(1)}).
			</p>
			{diagnosis ? (
				<p className="mt-1 text-xs text-[color:var(--muted)]">
					Largest contributor: {diagnosis.dimension}={diagnosis.value} (
					{formatNumber(diagnosis.current)} vs ~
					{formatNumber(Math.round(diagnosis.baseline_avg))} typical).
				</p>
			) : null}
			{/* btn-ghost + the global focus-visible outline, replacing the hardcoded accent-400/700
			    ramp this button used to carry (which renders wrong in dark mode). */}
			{onInvestigate && diagnosis ? (
				<button
					type="button"
					data-selectable
					onClick={() => onInvestigate({ [diagnosis.dimension]: diagnosis.value })}
					className="btn-ghost mt-3 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium"
				>
					<Search className="h-3.5 w-3.5" aria-hidden="true" />
					Investigate {diagnosis.dimension} = {diagnosis.value}
				</button>
			) : null}
		</article>
	);
}

/** Compact row for a dismissed anomaly, with the one-click restore that makes dismissing safe. */
function DismissedRow({
	entry,
	now,
	onRestore,
}: {
	entry: Entry;
	now: number;
	onRestore: (id: string) => void;
}): ReactElement {
	const when = describeBucket(entry.anomaly.bucket, now);
	return (
		<li className="surface-2 flex items-center justify-between gap-3 rounded-xl px-3 py-2">
			<span className="min-w-0 truncate text-xs text-[color:var(--muted)]">
				{SEVERITY_META[entry.severity].label} · {entry.anomaly.metric}{' '}
				{entry.anomaly.direction} · {when.absolute}
			</span>
			<button
				type="button"
				onClick={() => onRestore(entry.id)}
				className="btn-ghost inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium"
			>
				<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
				Restore
			</button>
		</li>
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
	const { data, error, isLoading, isFetching, refetch } = useAnomalies(apiKey, siteId, range);
	// Storage is read (and pruned back under its cap) once per mount rather than on every render,
	// then kept in state so a dismiss re-filters without a refetch.
	const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
	const [showDismissed, setShowDismissed] = useState(false);
	// The id of the most recent dismissal in this session, so it can be undone in one click.
	const [undoable, setUndoable] = useState<string | null>(null);
	// Provenance mode overlays the transparency-log attestation on each anomaly. The checkpoint is fetched
	// lazily — only while the mode is on — so the default view never pays for it. `isLoading` is tracked so
	// the in-flight frame reads "checking…" rather than the false "no log" claim.
	const [provenance, setProvenance] = useState(false);
	const { data: checkpoint, isLoading: checkpointLoading } = useCheckpoint(
		provenance ? apiKey : '',
	);
	// Every hour label below is rendered in the active clock; subscribing here is what re-renders them
	// when the header toggle moves (the formatters are module state, not props).
	useClockMode();
	const now = Date.now();

	const entries = useMemo<Entry[]>(() => {
		const all = data?.anomalies ?? [];
		return all
			.map((a) => ({ anomaly: a, id: anomalyId(siteId, a), severity: severityFor(a.z) }))
			.sort((x, y) => compareAnomalies(x.anomaly, y.anomaly));
	}, [data, siteId]);

	const visible = entries.filter((e) => !dismissed.has(e.id));
	const hidden = entries.filter((e) => dismissed.has(e.id));
	// Only offer undo for a dismissal that is still in this response: after a range or site change the
	// id may not be here at all, and "Undo" would then restore nothing visible. When everything is
	// dismissed the empty state carries its own Restore, so the row would just duplicate it.
	const undoId = visible.length > 0 && hidden.some((e) => e.id === undoable) ? undoable : null;

	function onDismiss(id: string): void {
		dismissAnomaly(id);
		setDismissed((prev) => new Set(prev).add(id));
		setUndoable(id);
	}

	function onRestore(id: string): void {
		restoreAnomaly(id);
		setDismissed((prev) => {
			const next = new Set(prev);
			next.delete(id);
			return next;
		});
		setUndoable((prev) => (prev === id ? null : prev));
	}

	function restoreAll(): void {
		for (const entry of hidden) {
			restoreAnomaly(entry.id);
		}
		setDismissed((prev) => {
			const next = new Set(prev);
			for (const entry of hidden) next.delete(entry.id);
			return next;
		});
		setUndoable(null);
	}

	if (error && isAuthError(error)) {
		return <AuthErrorBanner />;
	}

	if (error) {
		return (
			<ErrorState
				message="Could not load anomalies"
				detail={error instanceof Error ? error.message : null}
				onRetry={() => void refetch()}
				retrying={isFetching}
			/>
		);
	}

	if (isLoading || !data) {
		return <CardSkeletons count={2} />;
	}

	return (
		<div className="space-y-4">
			{/* Detection scores site-wide pageviews (detectAnomalies uses the unfiltered event
			    predicate), so an active segment is declared, never quietly applied to the label. */}
			<SegmentNotice tab="anomalies" />
			<div className="flex flex-wrap items-center justify-between gap-3">
				{/* Orientation before the cards: how many, how bad, how recent, how many hidden. */}
				<p className="text-xs text-[color:var(--muted)]">
					{summaryLine(
						entries.map((e) => e.anomaly),
						now,
						hidden.length,
					)}
				</p>
				<ProvenanceToggle on={provenance} onToggle={() => setProvenance((v) => !v)} />
			</div>
			{provenance ? (
				checkpointLoading ? (
					<p className="rounded-lg border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] px-3 py-2 text-xs text-[color:var(--muted)]">
						Checking for a transparency log…
					</p>
				) : checkpoint ? (
					<p className="alert-ok rounded-lg px-3 py-2 text-xs">
						This deployment commits its metrics to a signed transparency log — open a
						Provable badge to check the signature and the proof in your browser.
					</p>
				) : (
					<p className="rounded-lg border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] px-3 py-2 text-xs text-[color:var(--muted)]">
						This deployment doesn't publish a transparency log, so these anomalies can't
						be cryptographically verified.
					</p>
				)
			) : null}
			{/* The live region stays mounted so the undo offer is announced when it appears. */}
			<div aria-live="polite">
				{undoId ? (
					<div className="alert-info flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs">
						<span>Anomaly dismissed on this browser only.</span>
						<button
							type="button"
							onClick={() => onRestore(undoId)}
							className="btn-ghost inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium"
						>
							<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
							Undo
						</button>
					</div>
				) : null}
			</div>
			{visible.length === 0 ? (
				hidden.length > 0 ? (
					// Distinct from "nothing was found": everything found here was hidden by hand.
					<EmptyState
						title={
							hidden.length === 1
								? 'Anomaly dismissed'
								: `All ${hidden.length} anomalies dismissed`
						}
						action={
							<button
								type="button"
								onClick={restoreAll}
								className="btn-ghost inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium"
							>
								<RotateCcw className="h-4 w-4" aria-hidden="true" />
								Restore {hidden.length === 1 ? 'it' : 'them'}
							</button>
						}
					>
						Detection still ran over this range — you've hidden what it flagged.
					</EmptyState>
				) : (
					// Reassure that detection ran, and say what "ran" means, so an empty tab doesn't
					// read as a broken tab.
					<EmptyState title="No anomalies detected">
						Every complete hour in this range was scored against the hours before it;
						none deviated far enough from its baseline to flag. Very short ranges have
						too few complete hours to build a baseline from.
					</EmptyState>
				)
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
									severity={entry.severity}
									now={now}
									onDismiss={onDismiss}
									onInvestigate={onInvestigate}
								/>
							</VerifiedMetric>
						) : (
							<AnomalyCard
								key={entry.id}
								id={entry.id}
								anomaly={entry.anomaly}
								severity={entry.severity}
								now={now}
								onDismiss={onDismiss}
								onInvestigate={onInvestigate}
							/>
						),
					)}
				</div>
			)}
			{hidden.length > 0 && visible.length > 0 ? (
				<div className="space-y-2">
					<button
						type="button"
						onClick={() => setShowDismissed((v) => !v)}
						aria-expanded={showDismissed}
						className="text-xs font-medium text-[color:var(--muted)] underline underline-offset-2 hover:text-[color:var(--ink)]"
					>
						{showDismissed ? 'Hide' : 'Show'} dismissed ({hidden.length})
					</button>
					{showDismissed ? (
						<ul className="space-y-2">
							{hidden.map((entry) => (
								<DismissedRow
									key={entry.id}
									entry={entry}
									now={now}
									onRestore={onRestore}
								/>
							))}
						</ul>
					) : null}
				</div>
			) : null}
		</div>
	);
}
