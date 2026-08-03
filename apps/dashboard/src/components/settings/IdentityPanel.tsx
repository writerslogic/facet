// Identity & tier panel: sets a site's identity tier + salt window via PATCH /api/sites/:id/identity.
// There is no GET for the current config, so this is presented honestly as a "set tier" form whose
// result is the just-applied config (optimistic in that sense). The privacy tradeoff is stated plainly:
// `anonymous` (daily-rotating, no linkage) is the recommended default and forces the `day` window;
// elevating widens the linkage window for returning-visitor/retention analysis but requires a
// deployment signing key and visitor consent — and consent grants are server-to-server (site API key +
// CMP), NOT a dashboard action. Server errors (501 signing-unconfigured, 404 site) get friendly copy.
//
// The tier control starts UNSET rather than on `anonymous`. Pre-selecting a real tier on a form with no
// read-back is the trap here: the panel looked like it was reporting the site's current setting, when
// in fact it knew nothing about it. An explicit "not read from the server" placeholder cannot be
// mistaken for a reading, and it stops a stray submit from silently downgrading an elevated site.

import type { IdentityTier, SaltWindow, SetIdentityInput } from '@facet/shared';
import { Info, ShieldCheck } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useSetIdentity } from '../../hooks/admin.js';
import { BlockedReason, FormControls, MutationStatus, Panel, Select } from './kit.js';

const TIERS: { value: IdentityTier; label: string; blurb: string }[] = [
	{
		value: 'anonymous',
		label: 'Anonymous',
		blurb: 'Daily-rotating hash, no cross-day linkage. Recommended default. Forces the day window.',
	},
	{
		value: 'pseudonymous',
		label: 'Pseudonymous',
		blurb: 'A stable pseudonym within the salt window enables returning-visitor and retention analysis. Requires a deployment signing key and visitor consent.',
	},
	{
		value: 'identified',
		label: 'Identified',
		blurb: 'Links to a caller-supplied user id within the salt window. Requires a deployment signing key and explicit visitor consent.',
	},
];

const SALT_WINDOWS: SaltWindow[] = ['day', 'week', 'month'];

/** Map the server's error codes to friendly, honest copy; fall back to the raw message. */
function friendlyError(error: unknown): string | null {
	if (!error) return null;
	const message = error instanceof Error ? error.message : 'request_failed';
	if (message === 'identity_signing_unconfigured') {
		return 'A deployment signing key is required to elevate above anonymous. Configure it on the deployment, then try again.';
	}
	if (message === 'not_found') {
		return 'This site no longer exists. Select or create a site above.';
	}
	return `Error: ${message}`;
}

export function IdentityPanel({
	token,
	siteId,
}: {
	token: string;
	siteId: string;
}): ReactElement {
	const setIdentity = useSetIdentity(token, siteId);

	// '' is "no tier chosen yet", not a tier the server understands — see the file header.
	const [tier, setTier] = useState<IdentityTier | ''>('');
	const [saltWindow, setSaltWindow] = useState<SaltWindow>('day');

	// `anonymous` is always the day window (Tier 0); the server clamps it, and the UI mirrors that so the
	// selector never implies a choice the server would override.
	const anonymous = tier === 'anonymous';
	const effectiveWindow: SaltWindow = anonymous ? 'day' : saltWindow;

	function onTier(next: IdentityTier | ''): void {
		setTier(next);
		if (next === 'anonymous') setSaltWindow('day');
	}

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!tier) return;
		const body: SetIdentityInput = { tier, salt_window: effectiveWindow };
		setIdentity.mutate(body);
	}

	const activeBlurb = tier ? (TIERS.find((t) => t.value === tier)?.blurb ?? '') : '';
	const applied = setIdentity.data?.identity ?? null;

	return (
		<Panel
			title="Identity & tier"
			description="Controls how visitors are hashed, and therefore what can be linked across visits."
		>
			<p className="alert-info mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed">
				<Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span>
					<strong>This form writes; it does not read.</strong> The API has no endpoint
					that returns a site&rsquo;s current tier, so nothing below reflects what is
					configured right now — submitting replaces whatever is set. Only the
					confirmation after a successful save is a fact about the server.
				</span>
			</p>

			<p className="mb-4 max-w-prose text-[color:var(--muted)] text-xs leading-relaxed">
				Anonymous is a daily-rotating hash with no linkage and is recommended. Pseudonymous
				and identified widen the linkage window to enable returning-visitor and retention
				analysis, but require a deployment signing key and visitor consent. Consent grants
				are made server-to-server via the site&rsquo;s API key and your CMP — never from
				this dashboard.
			</p>

			<form onSubmit={onSubmit}>
				<FormControls busy={setIdentity.isPending} className="space-y-3">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Select
							id="identity-tier"
							label="Tier"
							value={tier}
							onChange={(next) => onTier(next as IdentityTier | '')}
						>
							<option value="">Choose a tier to apply…</option>
							{TIERS.map((t) => (
								<option key={t.value} value={t.value}>
									{t.label}
								</option>
							))}
						</Select>
						<Select
							id="identity-salt-window"
							label="Salt window"
							value={effectiveWindow}
							disabled={anonymous || !tier}
							onChange={(next) => setSaltWindow(next as SaltWindow)}
							hint={anonymous ? 'Anonymous forces the day window.' : undefined}
						>
							{SALT_WINDOWS.map((w) => (
								<option key={w} value={w}>
									{w}
								</option>
							))}
						</Select>
					</div>

					{activeBlurb ? (
						<p className="flex items-start gap-1.5 text-[color:var(--muted)] text-xs">
							<ShieldCheck
								className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--muted)]"
								aria-hidden="true"
							/>
							<span>{activeBlurb}</span>
						</p>
					) : null}

					<div className="space-y-1">
						<button
							type="submit"
							disabled={!tier}
							className="btn-accent rounded-lg px-4 py-1.5 text-sm transition"
						>
							Set identity
						</button>
						<BlockedReason
							reason={tier ? null : 'Choose a tier to apply to this site.'}
						/>
					</div>
				</FormControls>
			</form>

			<MutationStatus
				isPending={setIdentity.isPending}
				error={null}
				success={
					applied
						? `Identity set to ${applied.tier} (${applied.salt_window} window).`
						: null
				}
				pendingLabel="Applying identity config…"
			/>
			{setIdentity.error ? (
				<p
					role="alert"
					aria-live="assertive"
					className="alert-error mt-2 rounded-md px-2 py-1 font-medium text-xs"
				>
					{friendlyError(setIdentity.error)}
				</p>
			) : null}
		</Panel>
	);
}
