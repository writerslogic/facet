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

import type { ReactElement } from 'react';
import { useDealPipeline } from '../../hooks/crm.js';
import { crmBlockOf, formatMoney } from '../../lib/crm.js';
import { formatNumber } from '../../lib/format.js';
import { useDashboard } from '../../state.js';
import { ErrorState, Skeleton } from '../StatusStates.js';
import type { TileDef } from './types.js';

const BLOCK_TEXT: Record<string, string> = {
	unavailable: 'The CRM extension is not enabled on this deployment.',
	'accounts-off': 'Account sign-in is not configured on this deployment.',
	'signed-out': 'Sign in with your operator account to see the pipeline.',
	forbidden: 'Needs the analyst role or higher on the team that owns this site.',
};

/** The four CRM access states read as one calm explanatory line — never an alert, matching how the
 * CRM tab itself treats them. Only a genuinely transient failure gets the retryable red state. */
function PipelineNotice({
	error,
	onRetry,
	retrying,
}: {
	error: unknown;
	onRetry: () => void;
	retrying: boolean;
}): ReactElement {
	const block = error ? crmBlockOf(error) : null;
	if (!block) {
		return (
			<ErrorState
				message="Could not load the pipeline"
				detail={error instanceof Error ? error.message : null}
				onRetry={onRetry}
				retrying={retrying}
			/>
		);
	}
	return (
		<div className="alert-info flex h-full items-center rounded-lg p-3 text-sm">
			<p className="opacity-90">{BLOCK_TEXT[block]}</p>
		</div>
	);
}

function PipelineBody({ expanded }: { expanded?: boolean }): ReactElement {
	const { siteId } = useDashboard();
	const { data, error, isFetching, refetch } = useDealPipeline(siteId);

	if (!data && !error) return <Skeleton className="h-full w-full" />;
	if (error)
		return (
			<PipelineNotice error={error} onRetry={() => void refetch()} retrying={isFetching} />
		);

	const rows = data?.pipeline ?? [];
	if (rows.length === 0) {
		return (
			<div className="flex h-full flex-col justify-center gap-1">
				<div className="font-semibold text-[11px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
					Pipeline
				</div>
				<div className="text-[color:var(--muted)] text-sm">No priced deals yet.</div>
			</div>
		);
	}

	if (expanded) {
		return (
			<div className="grid h-full auto-rows-min grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
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

	// Collapsed: the first currency carries the headline figure — summing across currencies would add
	// unlike units, the same reason the API itself never returns one grand total. A second (or third)
	// currency is named rather than folded in, so the reader knows there is more behind "Expand".
	const [primary, ...rest] = rows;
	if (!primary) return <Skeleton className="h-full w-full" />;
	return (
		<div className="flex h-full flex-col justify-center gap-1">
			<div className="font-semibold text-[11px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
				Pipeline{rest.length > 0 ? ` · ${primary.currency}` : ''}
			</div>
			<div className="tabular flex items-baseline gap-2 font-semibold text-3xl text-[color:var(--ink)] leading-none tracking-[-0.02em]">
				{formatMoney(primary.open_value, primary.currency)}
			</div>
			<div className="mt-1 text-[color:var(--muted)] text-xs">
				{formatNumber(primary.open_count)} open ·{' '}
				{formatMoney(primary.won_value, primary.currency)} won
				{rest.length > 0
					? ` · +${rest.length} more ${rest.length === 1 ? 'currency' : 'currencies'}`
					: ''}
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
	render: (_ctx, expanded) => <PipelineBody expanded={expanded} />,
};
