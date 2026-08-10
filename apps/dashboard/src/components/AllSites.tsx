// All Sites: every saved profile on one screen, comparable at a glance.
//
// Facet has always stored many site profiles, but the only way to answer "how are all my sites
// doing" was to switch site N times and hold the numbers in your head. This is that answer: one row
// per profile over the dashboard's active range, with period-over-period deltas, a trend, and a
// sortable header so "which site moved" is a click rather than an act of memory.
//
// Two things drive the design:
//   1. Isolation. Each site is fetched with its OWN key (a key is bound to one site), so a revoked
//      key or a deleted site is a ROW-level failure with its own retry — every other site still
//      renders. That is the ordinary state of a multi-site account, not an edge case.
//   2. Honest aggregation. Pageviews and events are summable; visitors is not (see the footnote and
//      `hooks/allSites.ts`). The aggregate never presents a summed visitor count as a total.

import { ArrowDownRight, ArrowUpRight, ChevronsUpDown, RotateCw } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import {
	type SiteRollup,
	type SortDir,
	type SortKey,
	aggregateRollups,
	sortRollups,
	useAllSitesRollup,
} from '../hooks/allSites.js';
import { cn } from '../lib/cn.js';
import { type Delta, exactHint, formatKpi, formatNumber, toMovement } from '../lib/format.js';
import { useDashboard } from '../state.js';
import { DeltaBadge } from './Delta.js';
import { KpiCard } from './KpiCard.js';
import { siteColor } from './SiteSwitcher.js';
import { Sparkline } from './Sparkline.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	Skeleton,
} from './StatusStates.js';
import { hueForTitle } from './TopList.js';

const COLUMNS: { key: SortKey; label: string; hint?: string }[] = [
	{ key: 'site', label: 'Site' },
	{ key: 'pageviews', label: 'Pageviews' },
	{
		key: 'visitors',
		label: 'Visitors',
		hint: 'Distinct visitors per site. Counts are per-site and cannot be added together.',
	},
	{ key: 'events', label: 'Events' },
];

/** Number of metric columns + the trend column — the colspan a row-wide message has to cover. */
const METRIC_COLSPAN = 4;

/** Append the exact figure to a tile's tooltip when the tile itself is showing an abbreviation, so
 * compact notation never costs the reader the number. Returns the sentence unchanged otherwise. */
function withExact(sentence: string, value: number): string {
	const exact = exactHint(value);
	return exact ? `${sentence} Exact: ${exact}.` : sentence;
}

/** Compact delta pill for a table cell. Sign and arrow carry the meaning; colour only reinforces it. */
function MetricCell({ value, delta }: { value: number; delta: Delta | null }): ReactElement {
	return (
		<td className="whitespace-nowrap px-3 py-2 text-right align-middle">
			<div
				data-selectable
				className="font-semibold text-[color:var(--ink)] text-sm tabular-nums"
			>
				{formatNumber(value)}
			</div>
			{delta ? <DeltaBadge size="sm" movement={toMovement(delta)} /> : null}
		</td>
	);
}

/** The site identity cell: colour dot + label + site id. Clicking makes it the active site. */
function SiteCell({ row, active }: { row: SiteRollup; active: boolean }): ReactElement {
	const { setActiveProfile } = useDashboard();
	const color = siteColor(row.profile.siteId);
	return (
		<th scope="row" className="max-w-[22rem] px-3 py-2 text-left align-middle font-normal">
			<button
				type="button"
				// The label and site id inside this button are DATA, so they opt back into Cmd+A.
				data-selectable
				onClick={() => setActiveProfile(row.profile.id)}
				aria-current={active ? 'true' : undefined}
				className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition hover:bg-[color:rgb(var(--hover))]"
				title={active ? 'Currently the active site' : 'Make this the active site'}
			>
				<span
					aria-hidden="true"
					className="inline-block size-2.5 shrink-0 rounded-full"
					style={{ backgroundColor: color, boxShadow: `0 0 8px -1px ${color}` }}
				/>
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5">
						<span className="truncate font-medium text-[color:var(--ink)] text-sm">
							{row.profile.label}
						</span>
						{active ? (
							<span
								data-chrome
								className="chip-active shrink-0 rounded-full border px-1.5 py-px font-semibold text-[10px] uppercase tracking-wide"
							>
								Active
							</span>
						) : null}
						{row.isFetching ? (
							<span
								data-chrome
								className="shrink-0 animate-pulse text-[color:var(--faint)] text-[10px]"
							>
								updating…
							</span>
						) : null}
					</span>
					<span className="block truncate font-mono text-[11px] text-[color:var(--faint)]">
						{row.profile.siteId}
					</span>
				</span>
			</button>
		</th>
	);
}

/** One site's row. A failure here is confined to this `<tr>`; siblings are untouched. */
function SiteRow({ row, active }: { row: SiteRollup; active: boolean }): ReactElement {
	const spark = row.series.map((point) => point.pageviews);
	return (
		<tr className="border-[color:rgb(var(--border))] border-t align-middle">
			<SiteCell row={row} active={active} />
			{row.status === 'loading' ? (
				<td colSpan={METRIC_COLSPAN} className="px-3 py-2">
					<Skeleton className="h-6 w-full" />
					<span className="sr-only">Loading {row.profile.label}</span>
				</td>
			) : row.status === 'auth-error' ? (
				// A rejected key is not retryable — the fix is correcting the profile, which this banner
				// already explains. Retrying it would just burn requests against a key that cannot work.
				<td colSpan={METRIC_COLSPAN} className="px-3 py-2">
					<AuthErrorBanner />
				</td>
			) : row.status === 'error' ? (
				<td colSpan={METRIC_COLSPAN} className="px-3 py-2">
					<div className="flex items-start gap-2">
						<div className="min-w-0 flex-1">
							<ErrorState
								message={`Could not load ${row.profile.label}`}
								detail={row.error?.message ?? null}
							/>
						</div>
						<button
							type="button"
							onClick={row.retry}
							className="btn-ghost inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium text-xs transition"
						>
							<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
							Retry
						</button>
					</div>
				</td>
			) : (
				<>
					<MetricCell value={row.summary?.pageviews ?? 0} delta={row.deltas.pageviews} />
					<MetricCell value={row.summary?.visitors ?? 0} delta={row.deltas.visitors} />
					<MetricCell value={row.summary?.events ?? 0} delta={row.deltas.events} />
					<td className="px-3 py-2 text-right align-middle">
						{spark.length > 1 ? (
							<Sparkline
								values={spark}
								width={88}
								height={24}
								stroke={siteColor(row.profile.siteId)}
								fill
								marker
							/>
						) : (
							<span data-chrome className="text-[color:var(--faint)] text-xs">
								—
							</span>
						)}
					</td>
				</>
			)}
		</tr>
	);
}

export function AllSites(): ReactElement {
	const { profiles, activeProfileId, preset, range } = useDashboard();
	const interval = preset === '24h' ? 'hour' : 'day';
	const rows = useAllSitesRollup(profiles, range, interval);
	const [sortKey, setSortKey] = useState<SortKey>('pageviews');
	const [sortDir, setSortDir] = useState<SortDir>('desc');

	if (profiles.length === 0) {
		return (
			<EmptyState title="No sites saved">
				Add a site from the <strong>Site</strong> menu in the header, then come back here to
				compare them side by side.
			</EmptyState>
		);
	}

	const aggregate = aggregateRollups(rows);
	const sorted = sortRollups(rows, sortKey, sortDir);
	const allLoading = rows.every((row) => row.status === 'loading');
	const failed = aggregate.total - aggregate.loaded;
	const multi = profiles.length > 1;

	function toggleSort(key: SortKey): void {
		if (key === sortKey) {
			setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
			return;
		}
		setSortKey(key);
		// A metric starts at "biggest first" (the question is usually "which site is largest"), the
		// name column starts A→Z.
		setSortDir(key === 'site' ? 'asc' : 'desc');
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 pb-6">
			<div>
				<h2 className="font-semibold text-[color:var(--ink)] text-lg">All sites</h2>
				<p className="mt-0.5 text-[color:var(--muted)] text-sm">
					Every saved site over the selected range. Each site is read with its own key, so
					one site failing never hides the rest.
				</p>
			</div>

			{multi ? (
				allLoading ? (
					<CardSkeletons count={3} />
				) : (
					<>
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
							{/* The three aggregate tiles are fixed-width and sit above a table that
							    already carries every exact per-site figure — so a seven-digit total
							    abbreviates here and keeps its exact value on the tooltip. The TABLE
							    below never abbreviates: those cells are what people copy. */}
							<KpiCard
								label="Pageviews · all sites"
								value={formatKpi(aggregate.pageviews)}
								delta={aggregate.pageviewsDelta}
								sparkline={aggregate.pageviewSpark}
								sparklineStroke={hueForTitle('Pageviews')}
								hint={withExact(
									'Pageviews count occurrences, and an occurrence belongs to one site — this sum is exact.',
									aggregate.pageviews,
								)}
							/>
							<KpiCard
								label="Visitors · upper bound"
								value={`≤ ${formatKpi(aggregate.visitorsUpperBound)}`}
								hint={withExact(
									'Not a total. Each site counts distinct visitors under its own salt, so someone who visits two sites is counted twice.',
									aggregate.visitorsUpperBound,
								)}
							/>
							<KpiCard
								label="Events · all sites"
								value={formatKpi(aggregate.events)}
								delta={aggregate.eventsDelta}
								hint={withExact(
									'Events count occurrences, and an occurrence belongs to one site — this sum is exact.',
									aggregate.events,
								)}
							/>
						</div>
						<p className="text-[color:var(--faint)] text-xs">
							Pageviews and events add up across sites. Visitors does not: a visitor
							is a distinct per-site salted hash, so the same person on two sites is
							counted twice —{' '}
							<strong>≤ {formatNumber(aggregate.visitorsUpperBound)}</strong> is an
							upper bound on people, not a total.
						</p>
						{failed > 0 ? (
							<output className="alert-warn block rounded-xl px-4 py-2.5 text-sm">
								These figures cover {aggregate.loaded} of {aggregate.total} sites —{' '}
								{failed === 1 ? '1 site' : `${failed} sites`} could not be read. Fix
								or retry {failed === 1 ? 'it' : 'them'} below for a complete
								picture.
							</output>
						) : null}
					</>
				)
			) : null}

			<div className="surface overflow-x-auto rounded-2xl">
				<table className="w-full min-w-[38rem] border-collapse text-sm">
					<caption className="sr-only">
						Saved sites compared over the selected date range, sortable by column.
					</caption>
					<thead>
						<tr>
							{COLUMNS.map((column) => (
								<th
									key={column.key}
									scope="col"
									aria-sort={
										sortKey === column.key
											? sortDir === 'asc'
												? 'ascending'
												: 'descending'
											: 'none'
									}
									className={cn(
										'px-3 py-2',
										column.key === 'site' ? 'text-left' : 'text-right',
									)}
								>
									<button
										type="button"
										data-chrome
										onClick={() => toggleSort(column.key)}
										title={column.hint}
										className={cn(
											'inline-flex items-center gap-1 rounded-md px-1 py-0.5 font-semibold text-[11px] uppercase tracking-[0.06em] transition',
											sortKey === column.key
												? 'text-[color:var(--ink)]'
												: 'text-[color:var(--faint)] hover:text-[color:var(--ink)]',
										)}
									>
										{column.label}
										{sortKey === column.key ? (
											sortDir === 'asc' ? (
												<ArrowUpRight
													className="h-3 w-3"
													aria-hidden="true"
												/>
											) : (
												<ArrowDownRight
													className="h-3 w-3"
													aria-hidden="true"
												/>
											)
										) : (
											<ChevronsUpDown
												className="h-3 w-3 opacity-50"
												aria-hidden="true"
											/>
										)}
									</button>
								</th>
							))}
							<th
								scope="col"
								data-chrome
								className="px-3 py-2 text-right font-semibold text-[11px] text-[color:var(--faint)] uppercase tracking-[0.06em]"
							>
								Trend
							</th>
						</tr>
					</thead>
					<tbody>
						{sorted.map((row) => (
							<SiteRow
								key={row.profile.id}
								row={row}
								active={row.profile.id === activeProfileId}
							/>
						))}
					</tbody>
				</table>
			</div>

			{multi ? null : (
				<div className="surface-2 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm">
					<span className="text-[color:var(--muted)]">
						You have one site, so there is nothing to compare it against yet. Add a
						second from the <strong>Site</strong> menu in the header — each site keeps
						its own API key.
					</span>
				</div>
			)}
		</div>
	);
}
