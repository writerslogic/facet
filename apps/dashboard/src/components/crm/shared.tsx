// Building blocks shared by the contacts and companies panels: the four "you cannot read this"
// states, a status chip, a pager, a definition row, and the activity figures both analytics panels
// render. Everything reads the theme tokens, so the CRM tab matches the active palette in both modes.

import { Ban, Database, LogIn, ShieldOff } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { type CrmActivity, type CrmBlock, crmBlockOf } from '../../lib/crm.js';
import { formatDateTime } from '../../lib/datetime.js';
import { formatNumber } from '../../lib/format.js';
import { ErrorState } from '../StatusStates.js';

const BLOCKS: Record<CrmBlock, { icon: typeof Database; title: string; body: ReactNode }> = {
	unavailable: {
		icon: Database,
		title: 'The CRM extension is not enabled on this deployment',
		body: (
			<>
				Contacts and companies live in a <strong>second, separate D1 database</strong> that
				is optional and unbound by default — most Facet deployments never turn it on, and
				nothing else in the dashboard depends on it. Bind a database to <code>CRM_DB</code>{' '}
				and apply the CRM migrations to enable this tab.
			</>
		),
	},
	'accounts-off': {
		icon: ShieldOff,
		title: 'Account sign-in is not configured on this deployment',
		body: (
			<>
				The CRM holds names, emails and phone numbers, so it is gated on an operator session
				rather than an API key. This deployment has no <code>SESSION_SECRET</code>, so there
				is no way to authenticate a person — set one to use accounts and the CRM.
			</>
		),
	},
	'signed-out': {
		icon: LogIn,
		title: 'Sign in to read contacts',
		body: (
			<>
				Your saved site profile authenticates with an API key, and these routes deliberately
				refuse one: a key that leaks costs you pageview counts, whereas a key that could
				read contacts would cost you your customers&rsquo; names and emails. Sign in with
				your operator account (a magic link from <code>/api/auth/request</code>) and reload.
			</>
		),
	},
	forbidden: {
		icon: Ban,
		title: 'Your role does not include CRM access',
		body: (
			<>
				Reading contacts needs the <strong>analyst</strong> role or higher on the team that
				owns this site. A <strong>viewer</strong> can read aggregate analytics but not
				personal data — that is a different kind of access, not more of the same one. Ask a
				team admin to change your role.
			</>
		),
	},
};

/**
 * The explanation for a failed CRM read, or null when there was no error.
 *
 * A 501 is the DEFAULT state of a deployment that never bound `CRM_DB`, so it renders as a calm
 * explanatory panel — never an alert, never a toast, and with no retry, because nothing about it is
 * going to change on a second request. The same is true of the role and session states. Only an
 * unclassified failure gets the retryable error treatment.
 */
export function CrmAccessNotice({
	error,
	onRetry,
	retrying,
	subject = 'contacts',
}: {
	error: unknown;
	onRetry?: () => void;
	retrying?: boolean;
	/** What could not be read, for the transient-failure message. */
	subject?: string;
}): ReactElement | null {
	if (!error) return null;
	const block = crmBlockOf(error);
	if (!block) {
		return (
			<ErrorState
				message={`Could not load ${subject}`}
				detail={error instanceof Error ? error.message : null}
				onRetry={onRetry}
				retrying={retrying}
			/>
		);
	}
	const { icon: Icon, title, body } = BLOCKS[block];
	return (
		<div className="surface rounded-2xl p-8 text-center">
			<span
				className="mx-auto flex size-12 items-center justify-center rounded-full"
				style={{
					backgroundColor: 'var(--chip-bg)',
					boxShadow: 'inset 0 0 0 1px var(--chip-border)',
				}}
			>
				<Icon className="h-6 w-6" style={{ color: 'var(--chip-ink)' }} aria-hidden="true" />
			</span>
			<p className="mt-3 font-semibold text-[color:var(--ink)] text-sm">{title}</p>
			<div className="mx-auto mt-1.5 max-w-prose text-[color:var(--muted)] text-sm">
				{body}
			</div>
		</div>
	);
}

/** Lifecycle chip. The word carries the meaning; colour only reinforces it. */
export function StatusChip({ status }: { status: string }): ReactElement {
	return (
		<span
			data-chrome
			className="inline-flex shrink-0 items-center rounded-full border border-[color:rgb(var(--border))] px-2 py-px font-medium text-[11px] text-[color:var(--muted)] capitalize"
		>
			{status}
		</span>
	);
}

/** Label/value row for a detail pane. Renders an explicit dash when the field is unset. */
export function DetailRow({
	label,
	children,
}: {
	label: string;
	children?: ReactNode;
}): ReactElement {
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1">
			<dt data-chrome className="w-32 shrink-0 text-[color:var(--faint)] text-xs">
				{label}
			</dt>
			<dd
				data-selectable
				className="min-w-0 flex-1 break-words text-[color:var(--ink)] text-sm"
			>
				{children ?? <span className="text-[color:var(--faint)]">—</span>}
			</dd>
		</div>
	);
}

/** Offset pager. States the window and the total, so "25 rows" is never mistaken for "all of them". */
export function Pager({
	offset,
	pageSize,
	total,
	onOffset,
	noun,
}: {
	offset: number;
	pageSize: number;
	total: number;
	onOffset: (next: number) => void;
	noun: string;
}): ReactElement | null {
	if (total === 0) return null;
	const first = offset + 1;
	const last = Math.min(offset + pageSize, total);
	return (
		<div className="flex flex-wrap items-center justify-between gap-2">
			<p data-chrome className="text-[color:var(--faint)] text-xs">
				{first}–{last} of {formatNumber(total)} {noun}
			</p>
			<div className="flex gap-1.5">
				<button
					type="button"
					onClick={() => onOffset(Math.max(0, offset - pageSize))}
					disabled={offset === 0}
					className="btn-ghost rounded-md px-2.5 py-1 font-medium text-xs transition disabled:cursor-not-allowed disabled:opacity-50"
				>
					Previous
				</button>
				<button
					type="button"
					onClick={() => onOffset(offset + pageSize)}
					disabled={last >= total}
					className="btn-ghost rounded-md px-2.5 py-1 font-medium text-xs transition disabled:cursor-not-allowed disabled:opacity-50"
				>
					Next
				</button>
			</div>
		</div>
	);
}

/** One figure with its label. */
function Figure({ label, value }: { label: string; value: string }): ReactElement {
	return (
		<div className="surface-2 min-w-0 rounded-lg px-3 py-2">
			<p data-chrome className="text-[color:var(--faint)] text-[11px]">
				{label}
			</p>
			<p
				data-selectable
				className="truncate font-semibold text-[color:var(--ink)] text-sm tabular-nums"
			>
				{value}
			</p>
		</div>
	);
}

/**
 * The activity figures behind a link. `events` counts CUSTOM events only and `total` counts every
 * row, which is the same split `/api/stats` reports — labelling them both "events" would make the
 * two surfaces silently disagree about one person's numbers.
 */
export function ActivityFigures({ activity }: { activity: CrmActivity }): ReactElement {
	return (
		<div className="space-y-3">
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				<Figure label="Pageviews" value={formatNumber(activity.pageviews)} />
				<Figure label="Custom events" value={formatNumber(activity.events)} />
				<Figure label="Rows in total" value={formatNumber(activity.total)} />
				<Figure
					label="Last seen"
					value={activity.last_seen == null ? '—' : formatDateTime(activity.last_seen)}
				/>
			</div>
			{activity.first_seen == null ? null : (
				<p data-chrome className="text-[color:var(--faint)] text-xs">
					First seen {formatDateTime(activity.first_seen)}.
				</p>
			)}
			{activity.top_paths.length === 0 ? null : (
				<div>
					<p data-chrome className="mb-1 text-[color:var(--faint)] text-[11px]">
						Top paths
					</p>
					<ul className="space-y-0.5">
						{activity.top_paths.map((row) => (
							<li
								key={row.path}
								className="flex items-baseline justify-between gap-3 text-sm"
							>
								<span
									data-selectable
									className="min-w-0 truncate font-mono text-[color:var(--ink)] text-xs"
								>
									{row.path}
								</span>
								<span
									data-selectable
									className="shrink-0 text-[color:var(--muted)] text-xs tabular-nums"
								>
									{formatNumber(row.views)}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
