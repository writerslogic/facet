// Identity & tier panel: sets a site's identity tier + salt window via PATCH /api/sites/:id/identity.
// There is no GET for the current config, so this is presented honestly as a "set tier" form whose
// result is the just-applied config (optimistic in that sense). The privacy tradeoff is stated plainly:
// `anonymous` (daily-rotating, no linkage) is the recommended default and forces the `day` window;
// elevating widens the linkage window for returning-visitor/retention analysis but requires a
// deployment signing key and visitor consent — and consent grants are server-to-server (site API key +
// CMP), NOT a dashboard action. Server errors (501 signing-unconfigured, 404 site) get friendly copy.

import type { IdentityTier, SaltWindow, SetIdentityInput } from '@facet/shared';
import { ShieldCheck } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useSetIdentity } from '../../hooks/admin.js';
import { MutationStatus, Panel } from './kit.js';

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

	const [tier, setTier] = useState<IdentityTier>('anonymous');
	const [saltWindow, setSaltWindow] = useState<SaltWindow>('day');

	// `anonymous` is always the day window (Tier 0); the server clamps it, and the UI mirrors that so the
	// selector never implies a choice the server would override.
	const anonymous = tier === 'anonymous';
	const effectiveWindow: SaltWindow = anonymous ? 'day' : saltWindow;

	function onTier(next: IdentityTier): void {
		setTier(next);
		if (next === 'anonymous') setSaltWindow('day');
	}

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		const body: SetIdentityInput = { tier, salt_window: effectiveWindow };
		setIdentity.mutate(body);
	}

	const activeBlurb = TIERS.find((t) => t.value === tier)?.blurb ?? '';
	const applied = setIdentity.data?.identity ?? null;

	return (
		<Panel title="Identity & tier">
			<p className="mb-4 text-xs leading-relaxed text-neutral-500">
				Controls how visitors are hashed. Anonymous is a daily-rotating hash with no linkage
				and is recommended. Pseudonymous and identified widen the linkage window to enable
				returning-visitor and retention analysis, but require a deployment signing key and
				visitor consent. Consent grants are made server-to-server via the site&rsquo;s API
				key and your CMP — never from this dashboard.
			</p>

			<form onSubmit={onSubmit} className="space-y-3">
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div>
						<label
							htmlFor="identity-tier"
							className="block text-xs font-medium text-neutral-600"
						>
							Tier
						</label>
						<select
							id="identity-tier"
							value={tier}
							onChange={(e) => onTier(e.target.value as IdentityTier)}
							className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
						>
							{TIERS.map((t) => (
								<option key={t.value} value={t.value}>
									{t.label}
								</option>
							))}
						</select>
					</div>
					<div>
						<label
							htmlFor="identity-salt-window"
							className="block text-xs font-medium text-neutral-600"
						>
							Salt window
						</label>
						<select
							id="identity-salt-window"
							value={effectiveWindow}
							disabled={anonymous}
							onChange={(e) => setSaltWindow(e.target.value as SaltWindow)}
							className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 disabled:bg-neutral-50 disabled:text-neutral-400"
						>
							{SALT_WINDOWS.map((w) => (
								<option key={w} value={w}>
									{w}
								</option>
							))}
						</select>
						{anonymous ? (
							<p className="mt-1 text-xs text-neutral-400">
								Anonymous forces the day window.
							</p>
						) : null}
					</div>
				</div>

				<p className="flex items-start gap-1.5 text-xs text-neutral-500">
					<ShieldCheck
						className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400"
						aria-hidden="true"
					/>
					<span>{activeBlurb}</span>
				</p>

				<button
					type="submit"
					disabled={setIdentity.isPending}
					className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
				>
					Set identity
				</button>
			</form>

			<MutationStatus
				isPending={setIdentity.isPending}
				error={null}
				success={
					applied
						? `Identity set to ${applied.tier} (${applied.salt_window} window).`
						: null
				}
			/>
			{setIdentity.error ? (
				<p
					role="alert"
					aria-live="assertive"
					className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700"
				>
					{friendlyError(setIdentity.error)}
				</p>
			) : null}

			<p className="mt-3 text-xs text-neutral-400">
				There is no read-back of the current config, so this form sets the tier rather than
				reflecting it. The confirmation above shows the config the server just applied.
			</p>
		</Panel>
	);
}
