// API keys panel: issue a key (plaintext shown ONCE, then discarded), list keys without their hash,
// and revoke.
//
// The plaintext key exists only in this component's state. It is never written to storage by this
// panel; the one path that persists it — "Save in this browser" — writes to the site-profile store,
// so that consequence is now stated at the point of the click instead of being implied by the word
// "profile". "Done" wipes it from state so it stops sitting on screen for the rest of the session.
// The banner also carries the site id it was issued for and refuses to render against another site,
// so a mid-flow site switch cannot pair site A's key with site B's id.

import { Check, Copy, KeyRound } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useIssueKey, useKeys, useRevokeKey } from '../../hooks/admin.js';
import { formatDay } from '../../lib/datetime.js';
import { useDashboard } from '../../state.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import { ConfirmDelete, Field, FormControls, MutationStatus, Panel } from './kit.js';

interface IssuedKey {
	id: string;
	key: string;
	label: string;
	/** The site the key authenticates. Guards against the panel being reused for another site. */
	siteId: string;
}

export function KeysPanel({
	token,
	siteId,
}: {
	token: string;
	siteId: string;
}): ReactElement {
	const keys = useKeys(token, siteId);
	const issue = useIssueKey(token, siteId);
	const revoke = useRevokeKey(token, siteId);
	const { addProfile } = useDashboard();

	const [label, setLabel] = useState('');
	const [issued, setIssued] = useState<IssuedKey | null>(null);
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const [savedProfile, setSavedProfile] = useState(false);

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		const trimmed = label.trim();
		issue.mutate(
			{ site_id: siteId, ...(trimmed ? { label: trimmed } : {}) },
			{
				onSuccess: (res) => {
					setIssued({
						id: res.id,
						key: res.key,
						label: trimmed || 'Key',
						siteId,
					});
					setLabel('');
					setCopied(false);
					setCopyFailed(false);
					setSavedProfile(false);
				},
			},
		);
	}

	async function copyKey(): Promise<void> {
		if (!issued) return;
		try {
			await navigator.clipboard.writeText(issued.key);
			setCopied(true);
			setCopyFailed(false);
		} catch {
			// Clipboard access is denied outside a secure context; say so rather than silently
			// leaving a Copy button that appears to do nothing on an unrecoverable secret.
			setCopied(false);
			setCopyFailed(true);
		}
	}

	const showIssued = issued && issued.siteId === siteId ? issued : null;

	return (
		<Panel
			title="API keys"
			description="Keys authenticate read access to this site's stats. The key text is shown once, at issue time, and is never recoverable afterwards."
		>
			<form onSubmit={onSubmit}>
				<FormControls
					busy={issue.isPending}
					className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]"
				>
					<Field
						id="key-label"
						label="Label (optional)"
						value={label}
						onChange={setLabel}
						placeholder="Production key"
						hint="Names the key in this list. It is not part of the secret."
					/>
					<div className="flex items-start pt-5">
						<button
							type="submit"
							className="btn-accent w-full rounded-lg px-4 py-1.5 text-sm transition sm:w-auto"
						>
							Issue key
						</button>
					</div>
				</FormControls>
			</form>
			<MutationStatus
				isPending={issue.isPending}
				error={issue.error}
				pendingLabel="Issuing key…"
			/>

			{showIssued ? (
				<div className="alert-warn mt-4 rounded-lg p-4">
					<p className="flex items-center gap-1.5 font-semibold text-[color:var(--warn)] text-sm">
						<KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
						Copy this key now — it will not be shown again.
					</p>
					<p className="mt-1 text-[color:var(--muted)] text-xs">
						Only the hash is stored server-side. If you lose this value the key cannot
						be recovered; you would have to issue a new one and revoke this one.
					</p>
					<div className="mt-2 flex flex-wrap items-start gap-2">
						<code
							data-selectable
							className="min-w-0 flex-1 break-all rounded-md bg-[var(--panel)] px-3 py-1.5 font-mono text-[color:var(--ink)] text-sm"
						>
							{showIssued.key}
						</code>
						<button
							type="button"
							onClick={copyKey}
							className="btn-ghost inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 font-medium text-xs"
						>
							{copied ? (
								<Check className="h-3.5 w-3.5" aria-hidden="true" />
							) : (
								<Copy className="h-3.5 w-3.5" aria-hidden="true" />
							)}
							{copied ? 'Copied' : 'Copy key'}
						</button>
					</div>
					<p aria-live="polite" className="sr-only">
						{copied ? 'API key copied to clipboard.' : ''}
					</p>
					{copyFailed ? (
						<p role="alert" className="mt-2 font-medium text-neg text-xs">
							Could not write to the clipboard. Select the key above and copy it
							manually.
						</p>
					) : null}

					<div className="mt-3 flex flex-wrap items-center gap-2">
						{savedProfile ? (
							<p aria-live="polite" className="font-medium text-pos text-xs">
								Saved as a site profile in this browser.
							</p>
						) : (
							<button
								type="button"
								onClick={() => {
									addProfile({
										label: showIssued.label,
										siteId,
										apiKey: showIssued.key,
									});
									setSavedProfile(true);
								}}
								className="btn-ghost rounded-md px-3 py-1 font-medium text-xs transition"
							>
								Save in this browser
							</button>
						)}
						<button
							type="button"
							onClick={() => {
								setIssued(null);
								setCopied(false);
								setCopyFailed(false);
							}}
							className="btn-ghost rounded-md px-3 py-1 font-medium text-[color:var(--muted)] text-xs transition"
						>
							Done — hide key
						</button>
					</div>
					<p className="mt-2 text-[color:var(--faint)] text-xs">
						&ldquo;Save in this browser&rdquo; stores the key in this browser&rsquo;s
						local storage as a site profile so the dashboard can read this site. Skip it
						on a shared machine.
					</p>
				</div>
			) : null}

			<div className="mt-5">
				{keys.isLoading ? (
					<CardSkeletons count={2} />
				) : keys.error ? (
					<ErrorState
						message="Could not load keys"
						detail={keys.error instanceof Error ? keys.error.message : null}
					/>
				) : keys.data && keys.data.keys.length > 0 ? (
					<ul className="divide-y divide-[color:rgb(var(--border))]">
						{keys.data.keys.map((k) => (
							<li
								key={k.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-[color:var(--ink)]">
										{k.label ?? 'Unlabeled key'}
									</p>
									<p className="truncate text-[color:var(--muted)] text-xs">
										<code data-selectable className="font-mono">
											{k.id}
										</code>
										{k.last_used
											? ` · last used ${formatDay(k.last_used)}`
											: ' · never used'}
									</p>
								</div>
								<ConfirmDelete
									onConfirm={() => revoke.mutate(k.id)}
									label="Revoke"
									confirmLabel="Revoke key"
									consequence="Anything using this key stops reading immediately."
									busy={revoke.isPending}
								/>
							</li>
						))}
					</ul>
				) : (
					<EmptyState title="No keys yet">
						Issue a key above to authenticate reads.
					</EmptyState>
				)}
			</div>
			<MutationStatus
				isPending={revoke.isPending}
				error={revoke.error}
				pendingLabel="Revoking key…"
			/>
		</Panel>
	);
}
