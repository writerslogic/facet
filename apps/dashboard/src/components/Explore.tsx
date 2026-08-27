// The columnar-store panel: group the selected range by any one of the nineteen dimensions
// `GET /api/stats/breakdown` serves, including the long-tail columns no bento tile reaches (city,
// timezone, network, language, form factor, the three UTM columns, currency).
//
// This is the first dashboard surface that reads Analytics Engine, so WHICH STORE ANSWERED IS ON
// SCREEN, not buried in the response. The columnar store samples under load: `events` and
// `pageviews` come back sampling-corrected, but `visitors` is a distinct count no weight can
// correct, so a sampled figure is a LOWER bound. A panel that rendered an estimate in the same type
// as a measurement would be the one failure the whole source/sampled contract exists to prevent.

import type { BreakdownDimension, BreakdownRow } from '@facet/shared';
import { type ReactElement, useMemo, useState } from 'react';
import { useBreakdown } from '../hooks/breakdown.js';
import { useSegment } from '../hooks/segment.js';
import { cn } from '../lib/cn.js';
import { formatNumber } from '../lib/format.js';
import { type SegmentKey, segmentParams } from '../lib/segment.js';
import { isAuthError } from '../lib/status.js';
import type { Range } from '../state.js';
import { Card } from './Card.js';
import { SegmentNotice } from './CubeFilterBar.js';
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

/** Grouping for the picker. Every dimension appears exactly once, asserted by a test rather than by
 * counting the lists by eye — a dimension added to `BREAKDOWN_DIMENSIONS` and forgotten here would
 * otherwise be silently unreachable from the UI. */
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

const ROW_CHOICES = [25, 50, 100, 200] as const;

/** The dimensions that are also segment keys, so a row can be clicked to cross-filter the board.
 * The other fourteen have no `StatsQuery` parameter to narrow on and are read-only here. */
const FILTERABLE: Partial<Record<BreakdownDimension, SegmentKey>> = {
	path: 'path',
	referrer: 'referrer',
	country: 'country',
	device: 'device',
	channel: 'channel',
};

/** Share of the largest group's events, for the row bar. Guards the all-zero range: a bar drawn from
 * `0 / 0` is NaN width, which renders as a full-width bar on every row. */
function share(row: BreakdownRow, max: number): number {
	return max > 0 ? row.events / max : 0;
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

export function Explore({
	apiKey,
	siteId,
	range,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
}): ReactElement {
	const [dimension, setDimension] = useState<BreakdownDimension>('path');
	const [limit, setLimit] = useState<number>(25);
	const { segment, toggle } = useSegment();

	const query = useMemo(
		() => ({ site_id: siteId, start: range.start, end: range.end, ...segmentParams(segment) }),
		[siteId, range.start, range.end, segment],
	);
	const { data, isLoading, error, refetch, isFetching } = useBreakdown(
		apiKey,
		query,
		dimension,
		limit,
	);

	if (isAuthError(error)) return <AuthErrorBanner />;

	const rows = data?.rows ?? [];
	const max = rows.reduce((m, r) => Math.max(m, r.events), 0);
	const filterKey = FILTERABLE[dimension];

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-[color:var(--muted)] text-sm">
					Group the selected range by any dimension the columnar store carries.
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<label className="sr-only" htmlFor="explore-dimension">
						Group by
					</label>
					<select
						id="explore-dimension"
						data-chrome
						value={dimension}
						onChange={(e) => setDimension(e.target.value as BreakdownDimension)}
						className="rounded-lg border border-[color:rgb(var(--border))] bg-[var(--panel)] px-2.5 py-1.5 text-[color:var(--ink)] text-sm"
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
					<label className="sr-only" htmlFor="explore-rows">
						Rows
					</label>
					<select
						id="explore-rows"
						data-chrome
						value={limit}
						onChange={(e) => setLimit(Number(e.target.value))}
						className="rounded-lg border border-[color:rgb(var(--border))] bg-[var(--panel)] px-2.5 py-1.5 text-[color:var(--ink)] text-sm"
					>
						{ROW_CHOICES.map((n) => (
							<option key={n} value={n}>
								{n} rows
							</option>
						))}
					</select>
					{data ? <SourceBadge source={data.source} sampled={data.sampled} /> : null}
				</div>
			</div>

			<SegmentNotice tab="explore" />

			{error ? (
				<ErrorState
					message="Could not load the breakdown"
					detail={error instanceof Error ? error.message : null}
					onRetry={() => void refetch()}
					retrying={isFetching}
				/>
			) : isLoading ? (
				<CardSkeletons count={1} />
			) : rows.length === 0 ? (
				<EmptyState title={`No ${LABELS[dimension].toLowerCase()} data in this range`}>
					Every group in this range is below the k-anonymity floor of 3 distinct visitors,
					or this dimension was never recorded. Widen the range, or pick another
					dimension.
				</EmptyState>
			) : (
				<Card>
					<div className="overflow-x-auto">
						<table
							className="w-full text-sm"
							aria-label={`${LABELS[dimension]} breakdown`}
						>
							<thead>
								<tr>
									<th className="w-1/2 px-2 py-1.5 text-left font-semibold text-[10px] text-[color:var(--faint)] uppercase tracking-[0.06em]">
										{LABELS[dimension]}
									</th>
									{['Events', 'Pageviews', 'Visitors'].map((c) => (
										<th
											key={c}
											className="px-2 py-1.5 text-right font-semibold text-[10px] text-[color:var(--faint)] uppercase tracking-[0.06em]"
										>
											{c}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => {
									const label = row.key === '' ? '(not set)' : row.key;
									return (
										<tr
											key={row.key}
											className="border-[color:rgb(var(--border))] border-t"
										>
											<td className="relative max-w-0 px-2 py-1.5">
												<span
													aria-hidden="true"
													className="absolute inset-y-0.5 left-0 rounded-sm bg-[color:rgb(var(--accent-rgb)/0.14)]"
													style={{ width: `${share(row, max) * 100}%` }}
												/>
												{filterKey && row.key !== '' ? (
													<button
														type="button"
														onClick={() => toggle(filterKey, row.key)}
														title={`Filter the board by ${LABELS[dimension].toLowerCase()} ${label}`}
														className="relative block max-w-full truncate text-left text-[color:var(--ink)] hover:underline"
													>
														{label}
													</button>
												) : (
													<span className="relative block max-w-full truncate text-[color:var(--ink)]">
														{label}
													</span>
												)}
											</td>
											<td className="px-2 py-1.5 text-right text-[color:var(--ink)] tabular-nums">
												{formatNumber(row.events)}
											</td>
											<td className="px-2 py-1.5 text-right text-[color:var(--muted)] tabular-nums">
												{formatNumber(row.pageviews)}
											</td>
											<td className="px-2 py-1.5 text-right text-[color:var(--muted)] tabular-nums">
												{formatNumber(row.visitors)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
					<p className="mt-3 text-[color:var(--faint)] text-xs">
						Groups with fewer than 3 distinct visitors are omitted, so these rows do not
						sum to the site total.
						{data?.sampled
							? ' This range was sampled: every count is an estimate, and visitors is a lower bound.'
							: ''}
					</p>
				</Card>
			)}
		</div>
	);
}
