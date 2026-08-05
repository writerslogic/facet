// The access log: who touched this site's contacts, what they touched, and when.
//
// Two things about this data are easy to misread, so the panel states both rather than leaving the
// reader to infer them from a table:
//
//   • AN ENTRY IS AN AUTHORIZED ATTEMPT, NOT A SUCCESS. The server writes it before the handler runs,
//     which is what makes an unrecorded access impossible — and the cost is that a request which then
//     found nothing looks identical to one that returned a record. Read as "succeeded", a run of
//     probes against ids that do not exist becomes a run of disclosures that never happened.
//   • THE LOG HAS A HORIZON. It is the one CRM table on a retention schedule, so an empty result means
//     either that nothing happened or that it happened too long ago. The server reports the window
//     with every page precisely so this panel can say which.
//
// `target_id` is shown raw and never resolved to a name. The log holds no contact fields by design,
// and after an erasure the id points at nothing — so the honest offer is "filter by this id", not a
// label the log cannot stand behind.

import { ArrowLeft, ScrollText } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { CRM_PAGE_SIZE, useCrmAudit } from '../../hooks/crm.js';
import { cn } from '../../lib/cn.js';
import { type AuditTone, auditActionText, auditTone } from '../../lib/crm.js';
import { formatDateTime } from '../../lib/datetime.js';
import { CardSkeletons, EmptyState } from '../StatusStates.js';
import { CrmAccessNotice, Pager } from './shared.js';

/** Every action, for the filter. Ordered by subject then by how much the act discloses, so the two
 * an auditor scans for — the export and the erasures — are not buried mid-list. */
const ACTIONS: string[] = [
	'contact.export',
	'contact.delete',
	'company.delete',
	'contact.list',
	'contact.read',
	'contact.create',
	'contact.update',
	'contact.analytics',
	'company.list',
	'company.read',
	'company.create',
	'company.update',
	'company.contacts',
	'company.analytics',
	'audit.read',
];

const TONE_CLASS: Record<AuditTone, string> = {
	erase: 'alert-error',
	export: 'alert-warn',
	write: 'chip-active',
	read: '',
};

/** The act, weighted by what it was. An erasure and a list read are both "an access" and are not the
 * same event; colour only reinforces a word that already says so. */
function ActionCell({ action }: { action: string }): ReactElement {
	const tone = auditTone(action);
	return (
		<span
			data-selectable
			className={cn(
				'inline-flex items-center rounded-full px-2 py-px font-medium text-[11px]',
				tone === 'read'
					? 'text-[color:var(--muted)]'
					: cn(TONE_CLASS[tone], 'border-transparent'),
			)}
		>
			{auditActionText(action)}
		</span>
	);
}

export function AuditPanel({
	siteId,
	targetId,
	onTarget,
}: {
	siteId: string;
	/** Set when the reader arrived from a contact or company, asking about that record specifically. */
	targetId: string;
	onTarget: (id: string) => void;
}): ReactElement {
	const [action, setAction] = useState('');
	const [actorUserId, setActorUserId] = useState('');
	const [offset, setOffset] = useState(0);

	const log = useCrmAudit(siteId, { action, targetId, actorUserId, offset });

	if (log.error) {
		return (
			<CrmAccessNotice
				error={log.error}
				subject="the access log"
				forbidden={{
					title: 'Reading the access log needs the admin role',
					body: (
						<>
							A level above what reading contacts needs, and not because the log holds
							more: nothing in it is contact data — every entry is an id, a role, an
							action and a time. It is that what it reports is your{' '}
							<strong>colleagues</strong>, and a record of what each person read is
							oversight in an administrator&rsquo;s hands and surveillance in a
							peer&rsquo;s.
						</>
					),
				}}
				onRetry={() => void log.refetch()}
				retrying={log.isFetching}
			/>
		);
	}

	const entries = log.data?.entries ?? [];
	const total = log.data?.total ?? 0;
	const filtering = Boolean(action || targetId || actorUserId);
	const clear = (): void => {
		setAction('');
		setActorUserId('');
		onTarget('');
		setOffset(0);
	};

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-end gap-2">
				<div className="min-w-0">
					<label
						htmlFor="crm-audit-action"
						className="block font-medium text-[color:var(--muted)] text-xs"
					>
						Action
					</label>
					<select
						id="crm-audit-action"
						value={action}
						onChange={(e) => {
							setAction(e.target.value);
							setOffset(0);
						}}
						className="input mt-1 block rounded-lg px-3 py-1.5 text-sm"
					>
						<option value="">Every action</option>
						{ACTIONS.map((value) => (
							<option key={value} value={value}>
								{auditActionText(value)}
							</option>
						))}
					</select>
				</div>
				{filtering ? (
					<button
						type="button"
						onClick={clear}
						className="btn-ghost inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-sm transition"
					>
						<ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
						Clear filters
					</button>
				) : null}
			</div>

			{targetId ? (
				<p
					data-chrome
					className="surface-2 rounded-lg px-3 py-2 text-[color:var(--muted)] text-xs"
				>
					Showing every recorded access to <code className="font-mono">{targetId}</code>.
					Entries survive the record they name — after an erasure the id resolves to
					nothing and the history of who read it remains.
				</p>
			) : null}
			{actorUserId ? (
				<p
					data-chrome
					className="surface-2 rounded-lg px-3 py-2 text-[color:var(--muted)] text-xs"
				>
					Showing one operator&rsquo;s activity.{' '}
					<button
						type="button"
						onClick={() => {
							setActorUserId('');
							setOffset(0);
						}}
						className="underline decoration-dotted underline-offset-2"
					>
						Show everyone
					</button>
				</p>
			) : null}

			{log.isLoading ? (
				<CardSkeletons count={2} />
			) : entries.length === 0 ? (
				<EmptyState title={filtering ? 'No matching entries' : 'Nothing recorded yet'}>
					{filtering ? (
						<>Clear the filters to see every recorded access.</>
					) : (
						<>
							Every authorized request to a contact or company is recorded here before
							it runs — including reads, which otherwise leave no trace at all.
						</>
					)}
				</EmptyState>
			) : (
				<>
					<div className="surface overflow-x-auto rounded-2xl">
						<table className="w-full min-w-[36rem] border-collapse text-sm">
							<caption className="sr-only">
								Recorded accesses to this site&rsquo;s contacts and companies.
							</caption>
							<thead>
								<tr>
									{['When', 'Who', 'Did', 'To'].map((label) => (
										<th
											key={label}
											scope="col"
											data-chrome
											className="px-3 py-2 text-left font-semibold text-[11px] text-[color:var(--faint)] uppercase tracking-[0.06em]"
										>
											{label}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{entries.map((entry) => (
									<tr
										key={entry.id}
										className="border-[color:rgb(var(--border))] border-t align-middle"
									>
										<td
											data-selectable
											className="whitespace-nowrap px-3 py-2 text-[color:var(--muted)] text-xs tabular-nums"
										>
											{formatDateTime(entry.occurred_at)}
										</td>
										<td className="max-w-[16rem] px-3 py-2">
											<button
												type="button"
												data-selectable
												onClick={() => {
													setActorUserId(entry.actor_user_id);
													setOffset(0);
												}}
												title={entry.actor_user_id}
												className="block w-full truncate rounded text-left text-[color:var(--ink)] text-sm underline decoration-dotted underline-offset-2"
											>
												{/* No email means the account has since been closed. The id is
												    still the answer to "who", so it is what shows. */}
												{entry.actor_email ?? entry.actor_user_id}
											</button>
											<span
												data-chrome
												className="text-[color:var(--faint)] text-[11px]"
											>
												as {entry.actor_role}
												{entry.actor_email ? null : ' · account closed'}
											</span>
										</td>
										<td className="px-3 py-2">
											<ActionCell action={entry.action} />
										</td>
										<td className="max-w-[14rem] px-3 py-2">
											{entry.target_id ? (
												<button
													type="button"
													data-selectable
													onClick={() => {
														onTarget(entry.target_id ?? '');
														setOffset(0);
													}}
													className="block w-full truncate rounded text-left font-mono text-[color:var(--muted)] text-xs underline decoration-dotted underline-offset-2"
												>
													{entry.target_id}
												</button>
											) : (
												<span
													data-chrome
													className="text-[color:var(--faint)] text-xs"
												>
													—
												</span>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<Pager
						offset={offset}
						pageSize={CRM_PAGE_SIZE}
						total={total}
						onOffset={setOffset}
						noun="entries"
					/>
				</>
			)}

			<div className="surface-2 flex items-start gap-2.5 rounded-lg p-3">
				<ScrollText
					className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--faint)]"
					aria-hidden="true"
				/>
				<div className="min-w-0 space-y-1 text-[color:var(--muted)] text-xs">
					<p>
						An entry records that an operator was <strong>authorized</strong> to do
						this, not that it succeeded. The record is written before the request runs —
						which is what makes an unrecorded access impossible — so a lookup that then
						found nothing appears exactly like one that returned a record. A run of
						reads against ids that do not exist is someone probing, not someone being
						shown anything.
					</p>
					{log.data ? (
						<p>
							Nothing before <strong>{formatDateTime(log.data.covers_since)}</strong>{' '}
							is retained (&thinsp;{log.data.retention_days} days&thinsp;). An empty
							result older than that means the entries aged out, <strong>not</strong>{' '}
							that nothing happened.
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
