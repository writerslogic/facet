// Prompts for the ADMIN_TOKEN when absent. The token is stored in memory/sessionStorage only via
// the admin store; it is never written to localStorage or the profile store, and never logged.
//
// The token is verified against GET /api/sites BEFORE it is handed to the store. Previously any
// string was accepted and persisted, so a typo unlocked a shell whose every panel then failed with a
// bare "Error: invalid_admin_token" and the bad value sat in sessionStorage until "Forget" was found.
// Verifying first keeps a rejected secret out of storage entirely and puts the failure on the field
// that caused it.

import { KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { adminFetch, isAdminAuthError, useAdmin } from '../../admin.js';

/** Map the auth failure to copy the operator can act on; anything else keeps the raw code. */
function gateError(error: unknown): string {
	if (isAdminAuthError(error)) {
		return 'That token was rejected. It must match the ADMIN_TOKEN secret set on the deployment.';
	}
	const message = error instanceof Error ? error.message : 'request_failed';
	if (message === 'request_failed') {
		return 'Could not reach the deployment to verify the token. Check that the API is running.';
	}
	return `Verification failed: ${message}`;
}

export function AdminTokenGate(): ReactElement {
	const { setToken } = useAdmin();
	const [value, setValue] = useState('');
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent): Promise<void> {
		event.preventDefault();
		const trimmed = value.trim();
		if (!trimmed || checking) return;
		setChecking(true);
		setError(null);
		try {
			// Cheapest admin-authenticated read. The token stays in the Authorization header — never
			// the URL — and is only committed to the store once the deployment has accepted it.
			await adminFetch<{ sites: unknown[] }>('/api/sites', trimmed);
			setValue('');
			setToken(trimmed);
		} catch (err) {
			setError(gateError(err));
			setChecking(false);
		}
	}

	return (
		<form onSubmit={onSubmit} className="surface mx-auto max-w-md rounded-2xl p-6">
			<div className="flex items-start gap-3">
				<ShieldAlert
					className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--warn)]"
					aria-hidden="true"
				/>
				<div>
					<h2 className="font-semibold text-[color:var(--ink)] text-lg">
						Admin token required
					</h2>
					<p className="mt-1 text-[color:var(--muted)] text-sm">
						Settings manages sites, keys, goals, funnels, experiments and flags for this
						deployment.
					</p>
				</div>
			</div>

			<div className="alert-warn mt-4 rounded-lg px-3 py-2 text-xs leading-relaxed">
				<p className="font-semibold">This token is deployment-wide.</p>
				<p className="mt-1">
					It grants full admin access to <strong>every site</strong> in this deployment,
					not just the one you are viewing, and it can issue and revoke API keys. It is
					not a per-site credential.
				</p>
			</div>

			<div className="mt-3 flex items-start gap-2 text-[color:var(--muted)] text-xs leading-relaxed">
				<KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<p>
					<span data-chrome>The token is the </span>
					<code className="rounded bg-[color:rgb(var(--hover))] px-1 py-0.5 font-mono text-[color:var(--ink)]">
						ADMIN_TOKEN
					</code>
					<span data-chrome> secret on the Worker. Set or rotate it with </span>
					<code className="rounded bg-[color:rgb(var(--hover))] px-1 py-0.5 font-mono text-[color:var(--ink)]">
						wrangler secret put ADMIN_TOKEN
					</code>
					<span data-chrome>
						. Once entered it is kept for this browser tab only — never in localStorage,
						never in a URL — and is cleared when the tab closes.
					</span>
				</p>
			</div>

			<label
				htmlFor="admin-token"
				className="mt-5 block font-medium text-[color:var(--ink)] text-sm"
			>
				Admin token
			</label>
			<input
				id="admin-token"
				type="password"
				value={value}
				onChange={(e) => {
					setValue(e.target.value);
					if (error) setError(null);
				}}
				autoComplete="off"
				spellCheck={false}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? 'admin-token-error' : undefined}
				className="input mt-1 block w-full rounded-lg px-3 py-2 text-sm"
			/>

			{error ? (
				<p
					id="admin-token-error"
					role="alert"
					aria-live="assertive"
					className="alert-error mt-2 rounded-md px-2 py-1 font-medium text-xs"
				>
					{error}
				</p>
			) : null}

			<button
				type="submit"
				disabled={!value.trim() || checking}
				className="btn-accent mt-5 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm transition disabled:cursor-not-allowed"
			>
				{checking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
				{checking ? 'Verifying…' : 'Enter admin'}
			</button>
		</form>
	);
}
