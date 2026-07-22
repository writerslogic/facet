// Cohort-retention view: the retention triangle rendered as a heatmap table (cohorts as rows, periods
// as columns, each cell color-graded by its 0..1 fraction). A period toggle (week default / day). The
// server `note` is surfaced prominently as an info callout because retention depth is bounded by the
// site's salt window — at the default daily window cross-period retention is legitimately ~0, not a bug.

import type { CohortPeriod } from '@facet/shared';
import { Info } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useRetention } from '../hooks/retention.js';
import { cn } from '../lib/cn.js';
import { formatNumber, formatPercent } from '../lib/format.js';
import { isAuthError } from '../lib/status.js';
import type { Range } from '../state.js';
import { Card } from './Card.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	Skeleton,
} from './StatusStates.js';

// Five accent-tinted bands over the 0..1 fraction. Each pairs a background with a text color chosen for
// AA contrast against that background, so a cell's value is never conveyed by color alone (the number
// is always shown, and each cell carries a title).
type Band = { bg: string; text: string };

const EMPTY_BAND: Band = { bg: 'bg-neutral-50', text: 'text-neutral-300' };

const BANDS: readonly Band[] = [
	{ bg: 'bg-accent-50', text: 'text-neutral-500' },
	{ bg: 'bg-accent-100', text: 'text-accent-700' },
	{ bg: 'bg-accent-200', text: 'text-accent-700' },
	{ bg: 'bg-accent-400', text: 'text-white' },
	{ bg: 'bg-accent-600', text: 'text-white' },
];

function bandFor(fraction: number): Band {
	if (fraction <= 0) return EMPTY_BAND;
	const idx = Math.min(BANDS.length - 1, Math.floor(fraction * BANDS.length));
	return BANDS[idx] ?? EMPTY_BAND;
}

function periodLabel(period: CohortPeriod): string {
	return period === 'week' ? 'Week' : 'Day';
}

function Legend(): ReactElement {
	return (
		<div className="flex items-center gap-2 text-xs text-neutral-500">
			<span>0%</span>
			<div className="flex overflow-hidden rounded" aria-hidden="true">
				{BANDS.map((band) => (
					<span key={band.bg} className={cn('h-3 w-6', band.bg)} />
				))}
			</div>
			<span>100%</span>
		</div>
	);
}

export function Retention({
	apiKey,
	siteId,
	range,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
}): ReactElement {
	const [period, setPeriod] = useState<CohortPeriod>('week');
	const { data, error, isLoading } = useRetention(apiKey, siteId, range, period);

	const toggle = (
		<div className="inline-flex rounded-lg border border-neutral-200 p-0.5">
			{(['week', 'day'] as CohortPeriod[]).map((p) => (
				<button
					key={p}
					type="button"
					onClick={() => setPeriod(p)}
					aria-pressed={period === p}
					className={cn(
						'rounded-md px-3 py-1 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
						period === p
							? 'bg-neutral-900 text-white'
							: 'text-neutral-500 hover:text-neutral-800',
					)}
				>
					{p === 'week' ? 'Weekly' : 'Daily'}
				</button>
			))}
		</div>
	);

	const header = (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h2 className="text-sm font-semibold text-neutral-700">Cohort retention</h2>
				<p className="text-xs text-neutral-500">
					Visitors grouped by the period of their first activity, then the share returning
					later.
				</p>
			</div>
			{toggle}
		</div>
	);

	if (error && isAuthError(error)) {
		return <AuthErrorBanner />;
	}
	if (error) {
		return (
			<div className="space-y-4">
				{header}
				<ErrorState
					message="Could not load retention"
					detail={error instanceof Error ? error.message : null}
				/>
			</div>
		);
	}
	if (isLoading || !data) {
		return (
			<div className="space-y-4">
				{header}
				<CardSkeletons count={1} />
				<Skeleton className="h-[280px] w-full" />
			</div>
		);
	}

	const maxPeriods = data.cohorts.reduce((max, c) => Math.max(max, c.retention.length), 0);

	return (
		<div className="space-y-4">
			{header}

			<div
				role="note"
				className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800"
			>
				<Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" aria-hidden="true" />
				<span>{data.note}</span>
			</div>

			{data.cohorts.length === 0 ? (
				<EmptyState title="No cohorts in this range">
					Once visitors have a first-activity period in this window, their retention
					triangle will appear here.
				</EmptyState>
			) : (
				<Card>
					<div className="mb-3 flex items-center justify-end">
						<Legend />
					</div>
					<div className="overflow-x-auto">
						<table className="w-full border-separate border-spacing-1 text-sm">
							<caption className="sr-only">
								Cohort retention heatmap: each row is a cohort, each column is the
								number of {periodLabel(period).toLowerCase()}s after their first
								activity, and each cell is the fraction of that cohort still active.
							</caption>
							<thead>
								<tr>
									<th
										scope="col"
										className="px-2 py-1 text-left text-xs font-medium text-neutral-500"
									>
										Cohort
									</th>
									<th
										scope="col"
										className="px-2 py-1 text-right text-xs font-medium text-neutral-500"
									>
										Size
									</th>
									{Array.from({ length: maxPeriods }, (_, i) => (
										<th
											// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
											key={i}
											scope="col"
											className="px-2 py-1 text-center text-xs font-medium text-neutral-500 tabular-nums"
										>
											{periodLabel(period)} {i}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{data.cohorts.map((row) => (
									<tr key={row.cohort}>
										<th
											scope="row"
											className="whitespace-nowrap px-2 py-1 text-left font-medium text-neutral-700"
										>
											{row.cohort}
										</th>
										<td className="px-2 py-1 text-right text-xs tabular-nums text-neutral-500">
											{formatNumber(row.size)}
										</td>
										{Array.from({ length: maxPeriods }, (_, i) => {
											const fraction = row.retention[i];
											if (fraction == null) {
												return (
													// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
													<td key={i} className="px-1 py-1" />
												);
											}
											const band = bandFor(fraction);
											const label = formatPercent(fraction);
											return (
												<td
													// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
													key={i}
													className={cn(
														'rounded-md px-2 py-1 text-center text-xs font-medium tabular-nums',
														band.bg,
														band.text,
													)}
													title={`${row.cohort}, ${periodLabel(period).toLowerCase()} ${i}: ${label} of ${formatNumber(row.size)}`}
												>
													{label}
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Card>
			)}
		</div>
	);
}
