// Connection box: the connection-quality mix (fast/moderate/slow, bucketed at the edge from the TCP
// round-trip; k-anonymised). A performance-segmentation dimension Umami cannot offer at all.
//
// Rows are drawn fast → moderate → slow rather than by count: this is the board's one ORDINAL
// dimension, and count order shuffles a three-point scale into a sequence with no shape to read.
//
// COMPACT is deliberately not the shared leader row: over a closed three-value domain the leader is
// structurally "fast", so "who leads" answers nothing. The whole mix fits one stacked bar, headlined
// by the FAST share so the numeral means the same thing on every site and every window. A k-anonymity
// drop of the fast tier reads "0% fast", understating the good rather than asserting that a problem is
// absent. Values the tier bucketer cannot produce (legacy or imported rows) keep the ranked list.
//
// Not drillable: connection tier is not a filterable dimension in the API (see BrowsersBox).

import type { CountRow } from '@facet/shared';
import type { ReactElement } from 'react';
import { formatCompact, formatNumber } from '../../lib/format.js';
import { drillSpec } from './drill.js';
import { ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

/** The scale, best first: the row order, and the order the compact bar stacks in. Mirrors
 * `connectionTier` in the worker's request-meta, which is the only writer of this column. */
const TIERS: readonly string[] = ['fast', 'moderate', 'slow'];

/** Fast and slow carry the palette's status tokens because the scale has a real valence; moderate and
 * the off-scale bucket stay neutral. --c4/--c5 are NOT used: they flip hue between themes. */
const SEGMENT_COLOR: Record<string, string> = {
	fast: 'var(--pos)',
	moderate: 'var(--muted)',
	slow: 'var(--neg)',
	other: 'var(--faint)',
};

function tierRank(key: string): number {
	const i = TIERS.indexOf(key);
	return i < 0 ? TIERS.length : i;
}

function ordered(rows: readonly CountRow[]): CountRow[] {
	return [...rows].sort((a, b) => tierRank(a.key) - tierRank(b.key) || b.count - a.count);
}

/** Whether any row is on the tier scale. False means the response carries only values the bucketer
 * cannot produce, and the caller falls back to the shared list rendering. */
function onScale(rows: readonly CountRow[]): boolean {
	return rows.some((r) => TIERS.includes(r.key) && r.count > 0);
}

interface Segment {
	key: string;
	count: number;
	share: number;
}

function segmentsOf(rows: readonly CountRow[]): { segments: Segment[]; total: number } {
	const counts = new Map<string, number>();
	let total = 0;
	for (const row of rows) {
		const key = TIERS.includes(row.key) ? row.key : 'other';
		counts.set(key, (counts.get(key) ?? 0) + row.count);
		total += row.count;
	}
	const segments: Segment[] = [];
	for (const key of [...TIERS, 'other']) {
		const count = counts.get(key) ?? 0;
		if (count > 0) segments.push({ key, count, share: total > 0 ? count / total : 0 });
	}
	return { segments, total };
}

function TierBar({ rows }: { rows: readonly CountRow[] }): ReactElement {
	const { segments, total } = segmentsOf(rows);
	const fastShare = segments.find((s) => s.key === 'fast')?.share ?? 0;

	return (
		<div className="flex h-full min-h-0 flex-col justify-center gap-1.5 px-1">
			<div className="flex items-baseline gap-1.5">
				<span className="font-semibold text-[color:var(--ink)] text-lg leading-none tabular-nums">
					{Math.round(fastShare * 100)}%
				</span>
				<span className="font-medium text-[color:var(--ink)] text-xs">fast</span>
				<span className="ml-auto shrink-0 text-[10px] text-[color:var(--faint)] tabular-nums">
					{formatCompact(total)} events
				</span>
			</div>
			<div
				aria-hidden="true"
				className="flex h-1.5 w-full overflow-hidden rounded-full bg-[color:rgb(var(--hover))]"
			>
				{segments.map((s) => (
					<span
						key={s.key}
						className="h-full"
						style={{ width: `${s.share * 100}%`, background: SEGMENT_COLOR[s.key] }}
					/>
				))}
			</div>
			<table className="sr-only">
				<caption>
					Connection quality mix, as a share of the events with a reported connection
					tier.
				</caption>
				<thead>
					<tr>
						<th scope="col">Connection</th>
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

export const connectionBox: TileDef = {
	table: (ctx) => rowsTable('Connection', ordered(ctx.data.top_connections ?? [])),
	render: (ctx, density, config) => {
		const rows = ordered(ctx.data.top_connections ?? []);
		if (density === 'compact' && onScale(rows)) return <TierBar rows={rows} />;
		return (
			<ListBody
				title="Connection"
				rows={rows}
				density={density}
				config={config}
				compare={{
					current: ctx.data.top_connections ?? [],
					select: (p) => p.top_connections,
					// A quality mix has no good direction: more slow-connection events is worse service
					// and more reach at once, and the default 'up' would tint that rise green.
					direction: 'neutral',
				}}
				drill={drillSpec(ctx, null)}
				noun="Connection"
			/>
		);
	},
};
