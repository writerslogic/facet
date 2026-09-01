// Explore is the dashboard's general-purpose single-dimension analysis workspace. It deliberately
// stays on the bounded breakdown endpoint: the UI can rank, compare and search the returned groups,
// but it never asks for raw events or implies that k-anonymised/top-N rows sum to the site total.

import type { BreakdownDimension, BreakdownRow } from '@facet/shared';
import { BarChart3, Search, Table2 } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useBreakdown } from '../hooks/breakdown.js';
import { useSegment } from '../hooks/segment.js';
import { cn } from '../lib/cn.js';
import { countMovement, formatNumber, formatPercent } from '../lib/format.js';
import { type SegmentKey, segmentParams } from '../lib/segment.js';
import { isAuthError } from '../lib/status.js';
import { type Range, previousRange } from '../state.js';
import { Card } from './Card.js';
import { SegmentNotice } from './CubeFilterBar.js';
import { DeltaBadge } from './Delta.js';
import { AuthErrorBanner, CardSkeletons, EmptyState, ErrorState } from './StatusStates.js';

export const LABELS: Record<BreakdownDimension, string> = {
	hostname: 'Hostname',
	path: 'Path',
	referrer: 'Referrer',
	event: 'Event name',
	country: 'Country',
	region: 'Region',
	city: 'City',
	timezone: 'Timezone',
	network: 'Network',
	language: 'Language',
	device: 'Device',
	form_factor: 'Form factor',
	browser: 'Browser',
	os: 'Operating system',
	channel: 'Channel',
	utm_source: 'UTM source',
	utm_medium: 'UTM medium',
	utm_campaign: 'UTM campaign',
	currency: 'Currency',
};

/** Every API dimension appears exactly once. A test pins this contract. */
export const GROUPS: readonly { label: string; keys: readonly BreakdownDimension[] }[] = [
	{ label: 'Content', keys: ['path', 'hostname', 'event'] },
	{
		label: 'Acquisition',
		keys: ['referrer', 'channel', 'utm_source', 'utm_medium', 'utm_campaign'],
	},
	{ label: 'Location', keys: ['country', 'region', 'city', 'timezone', 'network'] },
	{ label: 'Technology', keys: ['device', 'form_factor', 'browser', 'os', 'language'] },
	{ label: 'Commerce', keys: ['currency'] },
];

export type ExploreMetric = 'events' | 'pageviews' | 'visitors';
type ExploreMode = 'chart' | 'table';

const METRICS: readonly ExploreMetric[] = ['events', 'pageviews', 'visitors'];
const METRIC_LABELS: Record<ExploreMetric, string> = {
	events: 'Events',
	pageviews: 'Pageviews',
	visitors: 'Visitors',
};
const ROW_CHOICES = [25, 50, 100, 200] as const;
const CHART_ROWS = 12;

const FILTERABLE: Partial<Record<BreakdownDimension, SegmentKey>> = {
	path: 'path',
	referrer: 'referrer',
	country: 'country',
	device: 'device',
	channel: 'channel',
};

interface ExploreState {
	dimension: BreakdownDimension;
	metric: ExploreMetric;
	mode: ExploreMode;
}

function readExploreState(search: string = window.location.search): ExploreState {
	const params = new URLSearchParams(search);
	const dimension = params.get('dimension') as BreakdownDimension | null;
	const metric = params.get('metric') as ExploreMetric | null;
	const mode = params.get('display') as ExploreMode | null;
	return {
		dimension: dimension && dimension in LABELS ? dimension : 'path',
		metric: metric && METRICS.includes(metric) ? metric : 'events',
		mode: mode === 'table' ? 'table' : 'chart',
	};
}

function writeExploreState(state: ExploreState): void {
	const url = new URL(window.location.href);
	url.searchParams.set('dimension', state.dimension);
	url.searchParams.set('metric', state.metric);
	url.searchParams.set('display', state.mode);
	window.history.replaceState(null, '', url);
}

function metricValue(row: BreakdownRow, metric: ExploreMetric): number {
	return row[metric];
}

/** Rank on the selected metric, with a stable lexical tie-break so rows do not jump unpredictably. */
export function rankRows(rows: readonly BreakdownRow[], metric: ExploreMetric): BreakdownRow[] {
	return [...rows].sort(
		(a, b) => metricValue(b, metric) - metricValue(a, metric) || a.key.localeCompare(b.key),
	);
}

function rowLabel(row: BreakdownRow): string {
	return row.key === '' ? '(not set)' : row.key;
}

function sumMetric(rows: readonly BreakdownRow[], metric: ExploreMetric): number {
	return rows.reduce((total, row) => total + metricValue(row, metric), 0);
}

function Kpi({
	label,
	value,
	detail,
	children,
}: {
	label: string;
	value: string;
	detail: string;
	children?: ReactElement | null;
}): ReactElement {
	return (
		<div className="surface min-w-0 rounded-2xl p-5">
			<dt className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--faint)]">
				{label}
			</dt>
			<dd className="mt-2 truncate font-semibold text-2xl text-[color:var(--ink)] tabular-nums">
				{value}
			</dd>
			<div className="mt-1 flex min-h-5 items-center gap-2 text-xs text-[color:var(--muted)]">
				<span className="truncate">{detail}</span>
				{children}
			</div>
		</div>
	);
}

export function SourceBadge({
	source,
	sampled,
}: {
	source: 'analytics_engine' | 'd1';
	sampled: boolean;
}): ReactElement {
	const columnar = source === 'analytics_engine';
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-[11px]',
				sampled ? 'alert-warn' : 'chip',
			)}
			title={
				sampled
					? 'Sampled: events and pageviews are corrected estimates, and visitors is a lower bound — a distinct count cannot be corrected for the rows sampling dropped.'
					: 'Exact: every matching row was counted.'
			}
		>
			{columnar ? 'Analytics Engine' : 'D1'}
			{sampled ? ' · sampled' : ' · exact'}
		</span>
	);
}

function BreakdownTable({
	rows,
	metric,
	total,
	previous,
	filterKey,
	dimension,
	onFilter,
}: {
	rows: BreakdownRow[];
	metric: ExploreMetric;
	total: number;
	previous: ReadonlyMap<string, BreakdownRow>;
	filterKey?: SegmentKey;
	dimension: BreakdownDimension;
	onFilter: (key: SegmentKey, value: string) => void;
}): ReactElement {
	return (
		<div className="overflow-x-auto">
			<table
				className="w-full text-sm"
				aria-label={`${LABELS[dimension]} breakdown raw data`}
			>
				<caption className="sr-only">
					Ranked {METRIC_LABELS[metric].toLowerCase()} by{' '}
					{LABELS[dimension].toLowerCase()}, with exact current and preceding-period
					values, share, and change.
				</caption>
				<thead>
					<tr>
						<th className="w-12 px-2 py-2 text-left text-[10px] text-[color:var(--faint)] uppercase">
							Rank
						</th>
						<th className="min-w-48 px-2 py-2 text-left text-[10px] text-[color:var(--faint)] uppercase">
							{LABELS[dimension]}
						</th>
						<th className="px-2 py-2 text-right text-[10px] text-[color:var(--faint)] uppercase">
							{METRIC_LABELS[metric]}
						</th>
						<th className="px-2 py-2 text-right text-[10px] text-[color:var(--faint)] uppercase">
							Previous
						</th>
						<th className="px-2 py-2 text-right text-[10px] text-[color:var(--faint)] uppercase">
							Change
						</th>
						<th className="px-2 py-2 text-right text-[10px] text-[color:var(--faint)] uppercase">
							Share
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row, index) => {
						const value = metricValue(row, metric);
						const before = previous.get(row.key);
						const priorValue = before ? metricValue(before, metric) : null;
						const movement = countMovement(value, priorValue);
						return (
							<tr
								key={row.key}
								className="border-[color:rgb(var(--border))] border-t"
							>
								<td className="px-2 py-2 text-[color:var(--faint)] tabular-nums">
									{index + 1}
								</td>
								<td className="max-w-0 px-2 py-2">
									{filterKey && row.key !== '' ? (
										<button
											type="button"
											onClick={() => onFilter(filterKey, row.key)}
											title={`Filter the board by ${LABELS[dimension].toLowerCase()} ${rowLabel(row)}`}
											className="block max-w-full truncate text-left text-[color:var(--ink)] hover:underline"
										>
											{rowLabel(row)}
										</button>
									) : (
										<span className="block max-w-full truncate text-[color:var(--ink)]">
											{rowLabel(row)}
										</span>
									)}
								</td>
								<td className="px-2 py-2 text-right font-medium text-[color:var(--ink)] tabular-nums">
									{formatNumber(value)}
								</td>
								<td className="px-2 py-2 text-right text-[color:var(--muted)] tabular-nums">
									{priorValue == null ? '—' : formatNumber(priorValue)}
								</td>
								<td className="px-2 py-2 text-right">
									<DeltaBadge movement={movement} variant="text" size="sm" />
									{movement ? null : (
										<span className="text-[color:var(--faint)]">—</span>
									)}
								</td>
								<td className="px-2 py-2 text-right text-[color:var(--muted)] tabular-nums">
									{total > 0 ? formatPercent(value / total) : '—'}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function BreakdownChart({
	rows,
	metric,
	previous,
	dimension,
}: {
	rows: BreakdownRow[];
	metric: ExploreMetric;
	previous: ReadonlyMap<string, BreakdownRow>;
	dimension: BreakdownDimension;
}): ReactElement {
	const shown = rows.slice(0, CHART_ROWS);
	const max = shown.reduce((peak, row) => {
		const before = previous.get(row.key);
		return Math.max(peak, metricValue(row, metric), before ? metricValue(before, metric) : 0);
	}, 0);
	return (
		<figure
			aria-label={`Top ${shown.length} ${LABELS[dimension].toLowerCase()} by ${METRIC_LABELS[metric].toLowerCase()}`}
			className="space-y-3"
		>
			{shown.map((row, index) => {
				const current = metricValue(row, metric);
				const before = previous.get(row.key);
				const prior = before ? metricValue(before, metric) : 0;
				return (
					<div
						key={row.key}
						className="grid grid-cols-[minmax(7rem,13rem)_1fr_auto] items-center gap-3"
					>
						<div className="flex min-w-0 items-center gap-2 text-sm">
							<span className="w-5 shrink-0 text-right text-[color:var(--faint)] tabular-nums">
								{index + 1}
							</span>
							<span
								className="truncate text-[color:var(--ink)]"
								title={rowLabel(row)}
							>
								{rowLabel(row)}
							</span>
						</div>
						<div className="relative h-7 overflow-hidden rounded-md bg-[color:rgb(var(--hover))]">
							{prior > 0 ? (
								<span
									className="absolute inset-y-1 left-0 rounded bg-[color:rgb(var(--border))]"
									style={{ width: `${max > 0 ? (prior / max) * 100 : 0}%` }}
								/>
							) : null}
							<span
								className="absolute inset-y-2 left-0 rounded bg-[color:var(--d1)]"
								style={{ width: `${max > 0 ? (current / max) * 100 : 0}%` }}
							/>
						</div>
						<span className="min-w-16 text-right font-medium text-sm text-[color:var(--ink)] tabular-nums">
							{formatNumber(current)}
						</span>
					</div>
				);
			})}
			<figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[color:var(--faint)]">
				<span>
					<span className="mr-1 inline-block h-1.5 w-4 rounded bg-[color:var(--d1)]" />
					Selected range
				</span>
				<span>
					<span className="mr-1 inline-block h-2.5 w-4 rounded bg-[color:rgb(var(--border))]" />
					Preceding period
				</span>
				{rows.length > CHART_ROWS ? (
					<span>Chart shows the top {CHART_ROWS}; Table shows all loaded rows.</span>
				) : null}
			</figcaption>
		</figure>
	);
}

export function Explore({
	apiKey,
	siteId,
	range,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
}): ReactElement {
	const initial = useMemo(() => readExploreState(), []);
	const [dimension, setDimension] = useState<BreakdownDimension>(initial.dimension);
	const [metric, setMetric] = useState<ExploreMetric>(initial.metric);
	const [mode, setMode] = useState<ExploreMode>(initial.mode);
	const [limit, setLimit] = useState<number>(50);
	const [search, setSearch] = useState('');
	const { segment, toggle } = useSegment();

	useEffect(() => writeExploreState({ dimension, metric, mode }), [dimension, metric, mode]);

	const query = useMemo(
		() => ({ site_id: siteId, start: range.start, end: range.end, ...segmentParams(segment) }),
		[siteId, range.start, range.end, segment],
	);
	const before = previousRange(range);
	const previousQuery = useMemo(
		() => ({
			site_id: siteId,
			start: before.start,
			end: before.end,
			...segmentParams(segment),
		}),
		[siteId, before.start, before.end, segment],
	);
	const current = useBreakdown(apiKey, query, dimension, limit);
	const comparison = useBreakdown(apiKey, previousQuery, dimension, limit);

	if (isAuthError(current.error)) return <AuthErrorBanner />;

	// placeholderData may still carry the last selected dimension while the new one loads. Never put
	// those rows under the new label; a stable layout is useful, a mislabeled answer is not.
	const data = current.data?.dimension === dimension ? current.data : undefined;
	const previousData = comparison.data?.dimension === dimension ? comparison.data : undefined;
	const ranked = rankRows(data?.rows ?? [], metric);
	const normalizedSearch = search.trim().toLocaleLowerCase();
	const rows = normalizedSearch
		? ranked.filter((row) => rowLabel(row).toLocaleLowerCase().includes(normalizedSearch))
		: ranked;
	const previousRows = new Map((previousData?.rows ?? []).map((row) => [row.key, row]));
	const total = sumMetric(ranked, metric);
	const previousTotal = sumMetric(previousData?.rows ?? [], metric);
	const leader = ranked[0] ?? null;
	const topThree = sumMetric(ranked.slice(0, 3), metric);
	const filterKey = FILTERABLE[dimension];
	const totalMovement = comparison.error ? null : countMovement(total, previousTotal);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2 className="font-semibold text-lg text-[color:var(--ink)]">
						Breakdown analysis
					</h2>
					<p className="mt-1 text-sm text-[color:var(--muted)]">
						Rank a dimension, compare it with the preceding period, then drill into a
						row.
					</p>
				</div>
				{data ? <SourceBadge source={data.source} sampled={data.sampled} /> : null}
			</div>

			<Card className="p-4">
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1.4fr_auto_auto]">
					<label className="grid gap-1 text-xs font-medium text-[color:var(--muted)]">
						Dimension
						<select
							id="explore-dimension"
							data-chrome
							value={dimension}
							onChange={(event) => {
								setDimension(event.target.value as BreakdownDimension);
								setSearch('');
							}}
							className="input rounded-lg px-2.5 py-2 text-sm text-[color:var(--ink)]"
						>
							{GROUPS.map((group) => (
								<optgroup key={group.label} label={group.label}>
									{group.keys.map((key) => (
										<option key={key} value={key}>
											{LABELS[key]}
										</option>
									))}
								</optgroup>
							))}
						</select>
					</label>
					<label className="grid gap-1 text-xs font-medium text-[color:var(--muted)]">
						Metric
						<select
							value={metric}
							onChange={(event) => setMetric(event.target.value as ExploreMetric)}
							className="input rounded-lg px-2.5 py-2 text-sm text-[color:var(--ink)]"
						>
							{METRICS.map((key) => (
								<option key={key} value={key}>
									{METRIC_LABELS[key]}
								</option>
							))}
						</select>
					</label>
					<label className="grid gap-1 text-xs font-medium text-[color:var(--muted)]">
						Search loaded groups
						<span className="input flex items-center gap-2 rounded-lg px-2.5">
							<Search
								className="h-4 w-4 shrink-0 text-[color:var(--faint)]"
								aria-hidden="true"
							/>
							<input
								type="search"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
								placeholder={`Find a ${LABELS[dimension].toLowerCase()}`}
								className="min-w-0 flex-1 bg-transparent py-2 text-sm text-[color:var(--ink)] outline-none"
							/>
						</span>
					</label>
					<label className="grid gap-1 text-xs font-medium text-[color:var(--muted)]">
						Rows
						<select
							id="explore-rows"
							value={limit}
							onChange={(event) => setLimit(Number(event.target.value))}
							className="input rounded-lg px-2.5 py-2 text-sm text-[color:var(--ink)]"
						>
							{ROW_CHOICES.map((count) => (
								<option key={count} value={count}>
									{count}
								</option>
							))}
						</select>
					</label>
					<div className="grid gap-1 text-xs font-medium text-[color:var(--muted)]">
						Display
						<div className="flex rounded-lg border border-[color:rgb(var(--border))] p-0.5">
							{(['chart', 'table'] as const).map((option) => {
								const Icon = option === 'chart' ? BarChart3 : Table2;
								return (
									<button
										key={option}
										type="button"
										aria-pressed={mode === option}
										onClick={() => setMode(option)}
										className={cn(
											'rounded-md p-2',
											mode === option ? 'chip-active' : 'btn-ghost',
										)}
										title={`Show ${option}`}
									>
										<Icon className="h-4 w-4" aria-hidden="true" />
										<span className="sr-only">{option}</span>
									</button>
								);
							})}
						</div>
					</div>
				</div>
			</Card>

			<SegmentNotice tab="explore" />

			{current.error ? (
				<ErrorState
					message="Could not load the breakdown"
					detail={current.error instanceof Error ? current.error.message : null}
					onRetry={() => void current.refetch()}
					retrying={current.isFetching}
				/>
			) : current.isLoading || !data ? (
				<CardSkeletons count={2} />
			) : ranked.length === 0 ? (
				<EmptyState title={`No ${LABELS[dimension].toLowerCase()} data in this range`}>
					Every group is below the k-anonymity floor of 3 distinct visitors, or this
					dimension was never recorded. Widen the range or choose another dimension.
				</EmptyState>
			) : (
				<>
					<dl
						className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
						aria-label="Explore summary"
					>
						<Kpi
							label={`Visible ${METRIC_LABELS[metric].toLowerCase()}`}
							value={formatNumber(total)}
							detail={`${formatNumber(ranked.length)} returned groups`}
						/>
						<Kpi
							label="Leading segment"
							value={leader ? rowLabel(leader) : '—'}
							detail={
								leader
									? `${formatNumber(metricValue(leader, metric))} ${METRIC_LABELS[metric].toLowerCase()}`
									: 'No segment'
							}
						/>
						<Kpi
							label="Top-three concentration"
							value={total > 0 ? formatPercent(topThree / total) : '—'}
							detail="Share of returned-group total"
						/>
						<Kpi
							label="Movement"
							value={formatNumber(total - previousTotal)}
							detail="Visible total vs preceding period"
						>
							<DeltaBadge movement={totalMovement} size="sm" />
						</Kpi>
					</dl>

					{comparison.error ? (
						<p className="alert-warn rounded-lg px-3 py-2 text-sm">
							The current ranking is available, but the preceding period could not be
							loaded. Change values are therefore unavailable.
						</p>
					) : null}

					{rows.length === 0 ? (
						<EmptyState title={`No groups match “${search.trim()}”`}>
							Search only checks the {formatNumber(ranked.length)} privacy-safe groups
							loaded for this breakdown. Clear the search or request more rows.
						</EmptyState>
					) : (
						<Card>
							<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
								<div>
									<h3 className="font-semibold text-[color:var(--ink)]">
										{LABELS[dimension]} ranked by{' '}
										{METRIC_LABELS[metric].toLowerCase()}
									</h3>
									<p className="mt-0.5 text-xs text-[color:var(--faint)]">
										{formatNumber(rows.length)} of {formatNumber(ranked.length)}{' '}
										loaded groups
									</p>
								</div>
								{filterKey ? (
									<span className="text-xs text-[color:var(--muted)]">
										Select a row label to cross-filter every supported view.
									</span>
								) : (
									<span className="alert-warn rounded-md px-2 py-1 text-xs">
										{LABELS[dimension]} cannot be cross-filtered yet; this
										endpoint can group it but the shared filter API does not
										accept it.
									</span>
								)}
							</div>
							{mode === 'chart' ? (
								<BreakdownChart
									rows={rows}
									metric={metric}
									previous={previousRows}
									dimension={dimension}
								/>
							) : (
								<BreakdownTable
									rows={rows}
									metric={metric}
									total={total}
									previous={previousRows}
									filterKey={filterKey}
									dimension={dimension}
									onFilter={toggle}
								/>
							)}
						</Card>
					)}

					<p className="text-xs text-[color:var(--faint)]">
						Shares and totals use only the returned, privacy-safe groups; groups with
						fewer than 3 distinct visitors and rows beyond the selected limit are
						excluded.
						{data.sampled
							? ' This range was sampled: events and pageviews are estimates, and visitors is a lower bound.'
							: ''}
					</p>
				</>
			)}
		</div>
	);
}
