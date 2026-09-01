// Browsers box: ranked list of browser families (UA client hints; `browserFamily` strips the version
// server-side). Rows are EVENT counts over the top families that clear the k-anonymity floor, so a
// share here is share-of-shown, never share-of-all-traffic.
//
// COMPACT is deliberately not the shared leader row: Chrome leads essentially every site, and brand
// is not the actionable unit — Chrome, Edge, Opera and Brave all render with Blink. Folded to the
// engine behind each family, the whole mix fits one stacked bar, headlined by the engine leading it,
// and shows how much of the audience needs testing off Blink. Rows that fold to nothing known keep
// the shared ranked-list compact, which is the honest rendering when the fold says nothing.
//
// Not drillable: browser is not one of the five dimensions the stats API can filter by, so the
// expanded view says so rather than drawing a breakdown it cannot scope. A per-slice browser mix is
// read by cross-filtering the board to a path or referrer, the only segment dimensions that re-query
// the server and so re-scope these rows. The cube-side dimensions and the drill panel have no browser
// axis at all.

import type { CountRow } from '@facet/shared';
import type { ReactElement } from 'react';
import { formatNumber } from '../../lib/format.js';
import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, accentOf, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

/** The families `browserFamily` can emit that are Blink builds. Safari and Firefox are engines of
 * their own and keep their own names, which read better on a tile than WebKit and Gecko. */
const CHROMIUM: readonly string[] = ['Chrome', 'Chromium', 'Edge', 'Opera', 'Brave'];

const BUCKETS: readonly string[] = ['Chromium', 'Safari', 'Firefox', 'other'];

/** Keyed rather than positional so a bucket keeps its colour when another one drops out. */
const BUCKET_COLOR: Record<string, string> = {
	Chromium: 'var(--c1)',
	Safari: 'var(--c2)',
	Firefox: 'var(--c3)',
};

/** Any family outside the three engines — `browserFamily`'s own 'Other', or a Sec-CH-UA brand it did
 * not recognise — has an engine the dashboard cannot establish, so it is bucketed as unknown rather
 * than assumed Blink. */
function bucketOf(key: string): string {
	if (CHROMIUM.includes(key)) return 'Chromium';
	if (key === 'Safari' || key === 'Firefox') return key;
	return 'other';
}

/** The unknown bucket sits outside the accent ramp: over a nominal domain a ramp step reads as another
 * engine, and this bucket is the absence of one. */
function segmentColor(key: string, rank: number, accent: string | undefined): string {
	if (key === 'other') return 'var(--faint)';
	if (accent) {
		return `color-mix(in srgb, ${accent} ${Math.max(30, 100 - rank * 22)}%, transparent)`;
	}
	return BUCKET_COLOR[key] ?? 'var(--faint)';
}

interface Segment {
	key: string;
	count: number;
	share: number;
	rank: number;
}

/** Empty buckets are dropped rather than drawn at 0%: a family under the k-anonymity floor is absent
 * from the response, so a zero segment would assert an absence the data cannot support. */
function segmentsOf(rows: readonly CountRow[]): Segment[] {
	const counts = new Map<string, number>();
	let total = 0;
	for (const row of rows) {
		const key = bucketOf(row.key);
		counts.set(key, (counts.get(key) ?? 0) + row.count);
		total += row.count;
	}
	const segments: Segment[] = [];
	for (const [rank, key] of BUCKETS.entries()) {
		const count = counts.get(key) ?? 0;
		if (count > 0) segments.push({ key, count, share: total > 0 ? count / total : 0, rank });
	}
	return segments;
}

/** The bucket the headline reports: the biggest one that is a known engine. Never a fixed bucket —
 * Chromium can be missing from the response entirely (every brand under the k-anonymity floor) and
 * "0% Chromium" would assert an absence the data cannot support. Null when nothing folds to an engine,
 * which is when the caller falls back to the shared ranked-list compact. */
function leadEngine(segments: readonly Segment[]): Segment | null {
	let lead: Segment | null = null;
	for (const s of segments) {
		if (s.key !== 'other' && (!lead || s.count > lead.count)) lead = s;
	}
	return lead;
}

function EngineMix({
	segments,
	lead,
	accent,
}: {
	segments: readonly Segment[];
	lead: Segment;
	accent?: string;
}): ReactElement {
	let runnerUp: Segment | undefined;
	for (const s of segments) {
		if (s !== lead && (!runnerUp || s.count > runnerUp.count)) runnerUp = s;
	}

	return (
		<div className="flex h-full min-h-0 flex-col justify-center gap-1.5 px-1">
			<div className="flex items-baseline gap-1.5">
				<span className="font-semibold text-[color:var(--ink)] text-lg leading-none tabular-nums">
					{Math.round(lead.share * 100)}%
				</span>
				<span className="min-w-0 truncate font-medium text-[color:var(--ink)] text-xs">
					{lead.key}
				</span>
				{runnerUp ? (
					<span className="ml-auto shrink-0 text-[10px] text-[color:var(--faint)] tabular-nums @max-[11rem]/tile:hidden">
						{runnerUp.key} {Math.round(runnerUp.share * 100)}%
					</span>
				) : null}
			</div>
			<div
				aria-hidden="true"
				className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-[color:rgb(var(--hover))]"
			>
				{segments.map((s) => (
					<span
						key={s.key}
						className="h-full transition-[flex-grow] duration-500"
						style={{
							flexGrow: s.share * 100,
							flexBasis: 0,
							background: segmentColor(s.key, s.rank, accent),
						}}
					/>
				))}
			</div>
			<table className="sr-only">
				<caption>Browser engine mix, as a share of the browser families shown.</caption>
				<thead>
					<tr>
						<th scope="col">Engine</th>
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

export const browsersBox: TileDef = {
	id: 'browsers',
	title: 'Browsers',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Browser', ctx.data.top_browsers ?? []),
	render: (ctx, density, config) => {
		const rows = ctx.data.top_browsers ?? [];
		const segments = density === 'compact' ? segmentsOf(rows) : [];
		const lead = leadEngine(segments);
		if (lead) {
			return <EngineMix segments={segments} lead={lead} accent={accentOf(config)} />;
		}
		return (
			<ListBody
				title="Browsers"
				rows={rows}
				density={density}
				config={config}
				compare={{ current: rows, select: (p) => p.top_browsers }}
				drill={drillSpec(ctx, null)}
				noun="Browser"
			/>
		);
	},
};
