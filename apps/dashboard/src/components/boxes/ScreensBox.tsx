// Screen-size box: the viewport-width mix (phone → ultrawide). Tiers are bucketed ON-DEVICE by the
// tracker, so the raw resolution never leaves the browser, and k-anonymised server-side: a share here
// is share-of-reported, never share-of-all-traffic.
//
// COMPACT is deliberately not the shared leader row. Screen tier is a CLOSED, ORDERED five-value
// domain, so "the leader plus +4 more" hides the one thing the dimension exists to show: how the
// audience spreads across the width scale. Drawn as the whole mix, stacked narrow → wide, headlined
// by the tier that leads it. Keys the tracker cannot emit (legacy or imported rows) keep the shared
// ranked-list compact, which is the honest rendering when nothing is on the scale. Default and
// expanded stay in COUNT order, where the list is a ranking and `ListDetail` names rows[0] the leader.
//
// Not drillable: screen tier is not a filterable dimension in the API (see BrowsersBox).

import type { CountRow } from '@facet/shared';
import type { ReactElement } from 'react';
import { exactHint, formatKpi, formatNumber } from '../../lib/format.js';
import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, accentOf, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

/** The width scale, narrowest first: the order the compact bar stacks in. Mirrors the tracker's
 * `viewport()` bucketer and the `screen` picklist the collector validates against, which are the only
 * writers of this column. */
const TIERS: readonly string[] = ['phone', 'tablet', 'laptop', 'desktop', 'ultrawide'];

/** A sequential ramp along the scale, because the scale is ordinal: neighbouring tiers read as
 * neighbours. Keyed to the tier's RANK, not to its position among the segments drawn, so a tier
 * dropping under the k-anonymity floor does not recolour the ones that remain. Off-scale rows sit
 * outside the ramp entirely. */
function segmentColor(rank: number, accent: string | undefined): string {
	if (rank >= TIERS.length) return 'var(--faint)';
	return `color-mix(in srgb, ${accent ?? 'var(--d2)'} ${Math.max(35, 100 - rank * 16)}%, transparent)`;
}

interface Segment {
	key: string;
	count: number;
	share: number;
	rank: number;
}

/** The mix in scale order, off-scale values folded into one trailing bucket. Empty tiers are dropped
 * rather than drawn at 0%: a tier under the k-anonymity floor is absent from the response, so a zero
 * segment would assert an absence the data cannot support. */
function segmentsOf(rows: readonly CountRow[]): { segments: Segment[]; total: number } {
	const counts = new Map<string, number>();
	let total = 0;
	for (const row of rows) {
		const key = TIERS.includes(row.key) ? row.key : 'other';
		counts.set(key, (counts.get(key) ?? 0) + row.count);
		total += row.count;
	}
	const segments: Segment[] = [];
	for (const [rank, key] of [...TIERS, 'other'].entries()) {
		const count = counts.get(key) ?? 0;
		if (count > 0) {
			segments.push({ key, count, share: total > 0 ? count / total : 0, rank });
		}
	}
	return { segments, total };
}

/** The tier the compact headline reports: the biggest one that is actually on the scale. Null when no
 * row is on it at all, which is when the caller falls back to the shared ranked-list rendering. */
function leadTier(rows: readonly CountRow[]): string | null {
	let lead: string | null = null;
	let best = 0;
	for (const row of rows) {
		if (!TIERS.includes(row.key) || row.count <= best) continue;
		lead = row.key;
		best = row.count;
	}
	return lead;
}

function TierMix({
	rows,
	lead,
	accent,
}: {
	rows: readonly CountRow[];
	lead: string;
	accent?: string;
}): ReactElement {
	const { segments, total } = segmentsOf(rows);
	const leadShare = segments.find((s) => s.key === lead)?.share ?? 0;

	return (
		<div className="flex h-full min-h-0 flex-col justify-center gap-1.5 px-1">
			<div className="flex min-h-0 items-baseline gap-1.5 overflow-hidden">
				<span className="font-semibold text-[color:var(--ink)] text-lg leading-none tabular-nums">
					{Math.round(leadShare * 100)}%
				</span>
				<span className="min-w-0 truncate font-medium text-[color:var(--ink)] text-xs">
					{lead}
				</span>
				<span
					className="ml-auto shrink-0 text-[10px] text-[color:var(--faint)] tabular-nums"
					title={exactHint(total) ?? undefined}
				>
					{formatKpi(total)} events
				</span>
			</div>
			<div
				aria-hidden="true"
				className="flex h-1.5 w-full shrink-0 gap-px overflow-hidden rounded-full bg-[color:rgb(var(--hover))]"
			>
				{segments.map((s) => (
					<span
						key={s.key}
						className="h-full transition-[flex-grow] duration-500"
						style={{
							flexGrow: s.share * 100,
							flexBasis: 0,
							background: segmentColor(s.rank, accent),
						}}
					/>
				))}
			</div>
			<table className="sr-only">
				<caption>
					Screen-size mix, narrowest first, as a share of the events with a reported
					viewport tier.
				</caption>
				<thead>
					<tr>
						<th scope="col">Screen</th>
						<th scope="col">Events</th>
						<th scope="col">Share</th>
					</tr>
				</thead>
				<tbody>
					{segments.map((s) => (
						<tr key={s.key}>
							<th scope="row">{s.key}</th>
							<td>{formatNumber(s.count)}</td>
							<td>{Math.round(s.share * 100)}%</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export const screensBox: TileDef = {
	id: 'screens',
	title: 'Screen size',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Screen', ctx.data.top_screens ?? []),
	render: (ctx, density, config) => {
		const rows = ctx.data.top_screens ?? [];
		const lead = density === 'compact' ? leadTier(rows) : null;
		if (lead) return <TierMix rows={rows} lead={lead} accent={accentOf(config)} />;
		return (
			<ListBody
				title="Screen size"
				rows={rows}
				density={density}
				config={config}
				compare={{ current: rows, select: (p) => p.top_screens }}
				drill={drillSpec(ctx, null)}
				noun="Screen size"
			/>
		);
	},
};
