// Pipeline box: the CRM's per-currency open/won deal totals, on the Overview board.
//
// THE AUTH SEAM. Every other box on this board reads `ctx`, computed once from a per-site API key
// (`clk_...`) fetch the Overview itself makes. The CRM's `/api/crm/pipeline` refuses that key by
// design — it is gated on an operator session cookie plus a team role, the same as every other CRM
// route — so this box cannot be a `ctx` projection like RevenueBox. It follows ClockBox's pattern
// instead: pull `siteId` from `useDashboard()`, run its own query, own its own loading/error UI. The
// two auth worlds never merge; this box just happens to sit on a board built for the other one.
//
// Not in `DEFAULT_LAYOUT`, matching `distributionBox`'s reasoning: most deployments never bind
// `CRM_DB`, and even one that does will show most viewers "sign in to see this" since Overview is
// usually read via API key, not a session. A tile that greets most visitors with a sign-in notice
// does not belong on the shipped board; it is one click away under "Add tile" for a deployment that
// wants it.

// THE THREE TIERS. `expanded` gives every currency its own card; `default` is one currency's open
// value with the others named, never summed. `compact` keeps that headline and nothing else — at
// ~56px tall, or 232px wide, the four access notices, the empty state and the retryable failure each
// shrink to one line rather than rendering a card clipped past its first sentence, and the figure
// drops its cents, since `$1,234,567.00` in that box is a number nobody can read anyway.

import type { ReactElement, ReactNode } from 'react';
import { useDealPipeline } from '../../hooks/crm.js';
import { cn } from '../../lib/cn.js';
import {
	type CrmBlock,
	type PipelineCurrencySummary,
	crmBlockOf,
	formatMoney,
} from '../../lib/crm.js';
import { uiLocale } from '../../lib/datetime.js';
import { COMPACT_ABOVE, formatNumber } from '../../lib/format.js';
import { useDashboard } from '../../state.js';
import { ErrorState, Skeleton } from '../StatusStates.js';
import type { TileDef, TileDensity } from './types.js';

const BLOCK_TEXT: Record<CrmBlock, string> = {
	unavailable: 'The CRM extension is not enabled on this deployment.',
	'accounts-off': 'Account sign-in is not configured on this deployment.',
	'signed-out': 'Sign in with your operator account to see the pipeline.',
	forbidden: 'Needs the analyst role or higher on the team that owns this site.',
};

/** The same four states in one clause each. Only the short form is drawn at `compact`; the sentence
 * above still reaches screen readers, and Expand shows it to everyone else. */
const BLOCK_SHORT: Record<CrmBlock, string> = {
	unavailable: 'CRM extension not enabled.',
	'accounts-off': 'Account sign-in not configured.',
	'signed-out': 'Sign in to see the pipeline.',
	forbidden: 'Needs the analyst role.',
};

/**
 * The headline figure in a fixed-width tile, per `COMPACT_ABOVE`'s rule: exact but without cents,
 * and compact notation above the threshold. `formatMoney` is right for the expanded cards and for a
 * figure someone reconciles against a deal, and wrong here — its cents are two characters of noise
 * that push a seven-digit total out of the box.
 */
function glanceMoney(cents: number, currency: string): string {
	const value = cents / 100;
	const big = Math.abs(value) >= COMPACT_ABOVE;
	try {
		return new Intl.NumberFormat(uiLocale(), {
			style: 'currency',
			currency,
			notation: big ? 'compact' : 'standard',
			maximumFractionDigits: big ? 1 : 0,
		}).format(value);
	} catch {
		// Unknown/invalid currency code — the label names it, so a plain number is not ambiguous.
	}
	return formatNumber(Math.round(value));
}

/** The `compact` frame: a label over one line of content, centred and clipped rather than reflowed,
 * so a tile squeezed to 34px by a focused neighbour still shows its middle. */
function CompactLine({ label, children }: { label: string; children: ReactNode }): ReactElement {
	return (
		<div className="flex h-full min-h-0 w-full flex-col justify-center gap-1 overflow-hidden">
			<span className="shrink-0 truncate font-semibold text-[10px] text-[color:var(--muted)] uppercase leading-none tracking-[0.08em]">
				{label}
			</span>
			{children}
		</div>
	);
}

/** The heading every tier shares. The currency is named even when it is the only one: the figure
 * below it is one currency's, and a bare symbol does not say which — nor does the plain-number
 * fallback for a code `Intl` refuses. */
function headingFor(row: PipelineCurrencySummary): string {
	return `Pipeline · ${row.currency}`;
}

/** The four CRM access states read as one calm explanatory line — never an alert, matching how the
 * CRM tab itself treats them. Only a genuinely transient failure gets the retryable red state. */
function PipelineNotice({
	error,
	onRetry,
	retrying,
	compact,
}: {
	error: unknown;
	onRetry: () => void;
	retrying: boolean;
	compact: boolean;
}): ReactElement {
	const block = error ? crmBlockOf(error) : null;
	if (!block) {
		if (!compact) {
			return (
				<ErrorState
					message="Could not load the pipeline"
					detail={error instanceof Error ? error.message : null}
					onRetry={onRetry}
					retrying={retrying}
				/>
			);
		}
		// The card is a p-4 block with a details disclosure; clipping it would take the retry with it,
		// which is the one thing on it that does anything.
		return (
			<CompactLine label="Pipeline">
				<div className="flex min-w-0 items-baseline gap-2">
					<p
						role="alert"
						className="min-w-0 truncate text-[color:var(--ink)] text-xs leading-tight"
					>
						Could not load the pipeline
					</p>
					<button
						type="button"
						onClick={onRetry}
						disabled={retrying}
						className="shrink-0 text-[10px] text-[color:var(--muted)] underline disabled:opacity-60"
					>
						{retrying ? 'Retrying' : 'Retry'}
					</button>
				</div>
			</CompactLine>
		);
	}
	if (compact) {
		return (
			<CompactLine label="Pipeline">
				<p className="text-[color:var(--ink)] text-xs leading-tight">
					<span aria-hidden="true">{BLOCK_SHORT[block]}</span>
					<span className="sr-only">{BLOCK_TEXT[block]}</span>
				</p>
			</CompactLine>
		);
	}
	return (
		<div className="alert-info flex h-full items-center rounded-lg p-3 text-sm">
			<p className="opacity-90">{BLOCK_TEXT[block]}</p>
		</div>
	);
}

/** No priced deals — distinct from no deals, and never rendered as a zero. */
function PipelineEmpty({ compact }: { compact: boolean }): ReactElement {
	if (compact) {
		return (
			<CompactLine label="Pipeline">
				<p className="text-[color:var(--ink)] text-xs leading-tight">
					No priced deals yet.
				</p>
			</CompactLine>
		);
	}
	return (
		<div className="flex h-full flex-col justify-center gap-1">
			<div className="font-semibold text-[11px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
				Pipeline
			</div>
			<div className="text-[color:var(--muted)] text-sm">No priced deals yet.</div>
		</div>
	);
}

function PipelineBody({ density }: { density: TileDensity }): ReactElement {
	const { siteId } = useDashboard();
	const { data, error, isFetching, refetch } = useDealPipeline(siteId);
	const compact = density === 'compact';

	if (!data && !error) return <Skeleton className="h-full w-full" />;
	if (error)
		return (
			<PipelineNotice
				error={error}
				onRetry={() => void refetch()}
				retrying={isFetching}
				compact={compact}
			/>
		);

	const rows = data?.pipeline ?? [];
	const [primary, ...rest] = rows;
	if (!primary) return <PipelineEmpty compact={compact} />;

	if (density === 'expanded') {
		return (
			<div
				className={cn(
					'grid h-full auto-rows-min grid-cols-1 gap-3 overflow-y-auto',
					rows.length > 1 && 'sm:grid-cols-2',
				)}
			>
				{rows.map((row) => (
					<div
						key={row.currency}
						className="rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] p-3"
					>
						<div className="font-semibold text-[10px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
							{row.currency}
						</div>
						<div className="tabular mt-1 font-semibold text-2xl text-[color:var(--ink)]">
							{formatMoney(row.open_value, row.currency)}
						</div>
						<div className="mt-1 text-[color:var(--muted)] text-xs">
							{formatNumber(row.open_count)} open ·{' '}
							{formatMoney(row.won_value, row.currency)} won (
							{formatNumber(row.won_count)})
						</div>
					</div>
				))}
			</div>
		);
	}

	// The first currency carries the headline figure — summing across currencies would add unlike
	// units, the same reason the API itself never returns one grand total. A second (or third)
	// currency is named rather than folded in, so the reader knows there is more behind "Expand".
	const more =
		rest.length > 0
			? ` · +${rest.length} more ${rest.length === 1 ? 'currency' : 'currencies'}`
			: '';

	if (compact) {
		return (
			<CompactLine label={headingFor(primary)}>
				<div className="flex min-w-0 items-baseline gap-x-2">
					<span className="tabular shrink-0 font-semibold text-[color:var(--ink)] text-lg leading-none tracking-[-0.02em]">
						{glanceMoney(primary.open_value, primary.currency)}
					</span>
					<span className="tabular truncate text-[10px] text-[color:var(--muted)] leading-none">
						{formatNumber(primary.open_count)} open{more}
					</span>
				</div>
			</CompactLine>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col justify-center gap-1 overflow-hidden">
			<div className="truncate font-semibold text-[11px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
				{headingFor(primary)}
			</div>
			<div className="tabular font-semibold text-3xl text-[color:var(--ink)] leading-none tracking-[-0.02em]">
				{Math.abs(primary.open_value / 100) >= COMPACT_ABOVE
					? glanceMoney(primary.open_value, primary.currency)
					: formatMoney(primary.open_value, primary.currency)}
			</div>
			<div className="mt-1 text-[color:var(--muted)] text-xs">
				{formatNumber(primary.open_count)} open ·{' '}
				{formatMoney(primary.won_value, primary.currency)} won{more}
			</div>
		</div>
	);
}

export const pipelineBox: TileDef = {
	id: 'pipeline',
	title: 'Pipeline',
	size: 'md',
	selfLabeled: true,
	emphasis: 'kpi',
	expandable: true,
	// No `table`: this box's numbers come from its own session-authed request, never from `ctx` — the
	// same reason `distributionBox` omits it for its own independent fetch.
	render: (_ctx, density) => <PipelineBody density={density} />,
};
