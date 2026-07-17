// API keys panel: issue a key (plaintext shown ONCE with a copy affordance + "won't be shown again"
// warning, and an offer to save it as a site profile), list keys without their hash, and revoke.

import { Check, Copy } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useIssueKey, useKeys, useRevokeKey } from '../../hooks/admin.js';
import { useDashboard } from '../../state.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import { ConfirmDelete, Field, MutationStatus, Panel } from './kit.js';

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
	const [issued, setIssued] = useState<{
		id: string;
		key: string;
		label: string;
	} | null>(null);
	const [copied, setCopied] = useState(false);
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
					});
					setLabel('');
					setCopied(false);
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
		} catch {
			setCopied(false);
		}
	}

	return (
		<Panel title="API keys">
			<form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
				<Field
					id="key-label"
					label="Label (optional)"
					value={label}
					onChange={setLabel}
					placeholder="Production key"
				/>
				<div className="flex items-end">
					<button
						type="submit"
						disabled={issue.isPending}
						className="w-full rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 sm:w-auto"
					>
						Issue key
					</button>
				</div>
			</form>
			<MutationStatus isPending={issue.isPending} error={issue.error} />

			{issued ? (
				<div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
					<p className="text-sm font-semibold text-amber-800">
						Copy this key now — it will not be shown again.
					</p>
					<div className="mt-2 flex items-center gap-2">
						<code className="flex-1 truncate rounded-md bg-white px-3 py-1.5 font-mono text-sm text-neutral-800">
							{issued.key}
						</code>
						<button
							type="button"
							onClick={copyKey}
							className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100"
						>
							{copied ? (
								<Check className="h-3.5 w-3.5" aria-hidden="true" />
							) : (
								<Copy className="h-3.5 w-3.5" aria-hidden="true" />
							)}
							{copied ? 'Copied' : 'Copy'}
						</button>
					</div>
					{savedProfile ? (
						<p aria-live="polite" className="mt-2 text-xs font-medium text-emerald-700">
							Saved as a site profile.
						</p>
					) : (
						<button
							type="button"
							onClick={() => {
								addProfile({
									label: issued.label,
									siteId,
									apiKey: issued.key,
								});
								setSavedProfile(true);
							}}
							className="mt-3 rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100"
						>
							Save as site profile
						</button>
					)}
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
					<ul className="divide-y divide-neutral-100">
						{keys.data.keys.map((k) => (
							<li
								key={k.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-neutral-800">
										{k.label ?? 'Unlabeled key'}
									</p>
									<p className="truncate text-xs text-neutral-400">
										{k.id}
										{k.last_used
											? ` · last used ${new Date(k.last_used).toLocaleDateString()}`
											: ' · never used'}
									</p>
								</div>
								<ConfirmDelete
									onConfirm={() => revoke.mutate(k.id)}
									label="Revoke"
									confirmLabel="Confirm revoke"
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
			<MutationStatus isPending={revoke.isPending} error={revoke.error} />
		</Panel>
	);
}
