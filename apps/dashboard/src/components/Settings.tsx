// Self-service admin area. Manages sites, API keys, goals, funnels, experiments and flags via the
// admin API. The ADMIN_TOKEN is entered here and kept in memory/sessionStorage only (never mixed
// with the site-credential store, never in a URL/log). All mutations invalidate the relevant list.
//
// Layout: everything below Sites is scoped to ONE selected site, which used to be implicit — eight
// panels ran together in a single scroll and silently referred to a selection made far above. The
// selection is now a pinned context bar and the per-site panels are tabbed, so only one is on screen
// and the site it belongs to is always visible with it.

import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { isAdminAuthError, useAdmin } from '../admin.js';
import { useSites } from '../hooks/admin.js';
import { cn } from '../lib/cn.js';
import { useDashboard } from '../state.js';
import { AdminTokenGate } from './settings/AdminTokenGate.js';
import { AlertsPanel } from './settings/AlertsPanel.js';
import { AppearancePanel } from './settings/AppearancePanel.js';
import { ExperimentsPanel } from './settings/ExperimentsPanel.js';
import { FlagsPanel } from './settings/FlagsPanel.js';
import { FunnelsPanel } from './settings/FunnelsPanel.js';
import { GoalsPanel } from './settings/GoalsPanel.js';
import { IdentityPanel } from './settings/IdentityPanel.js';
import { KeysPanel } from './settings/KeysPanel.js';
import { OperatorSessionsPanel } from './settings/OperatorSessionsPanel.js';
import { SessionPanel } from './settings/SessionPanel.js';
import { SitesPanel } from './settings/SitesPanel.js';

type SectionId = 'keys' | 'goals' | 'funnels' | 'experiments' | 'flags' | 'alerts' | 'identity';

const SECTIONS: { id: SectionId; label: string }[] = [
	{ id: 'keys', label: 'API keys' },
	{ id: 'goals', label: 'Goals' },
	{ id: 'funnels', label: 'Funnels' },
	{ id: 'experiments', label: 'Experiments' },
	{ id: 'flags', label: 'Feature flags' },
	{ id: 'alerts', label: 'Alerts' },
	{ id: 'identity', label: 'Identity' },
];

export function Settings(): ReactElement {
	const { hasToken, token, forgetToken } = useAdmin();
	const { activeProfile } = useDashboard();
	const [siteId, setSiteId] = useState<string>(activeProfile?.siteId ?? '');
	const [section, setSection] = useState<SectionId>('keys');
	// Shares the query key with SitesPanel, so this is the same request, not a second one. Used for
	// the context bar's site name and to notice a token the deployment has since stopped accepting.
	const sites = useSites(token);

	// Both of these are authorized by the operator's own session cookie, not by the admin token, so
	// they render on either side of the gate — an operator who never enters an ADMIN_TOKEN still has
	// an account, and ending its sessions is the one security control they can exercise alone.
	if (!hasToken) {
		return (
			<div className="space-y-6">
				<AppearancePanel />
				<SessionPanel />
				<AdminTokenGate />
			</div>
		);
	}

	// A token accepted at the gate can be rotated out from under the session. Say so once, here,
	// instead of letting all six panels each render their own bare "invalid_admin_token".
	const rejected = isAdminAuthError(sites.error);
	const selected = sites.data?.sites.find((s) => s.id === siteId) ?? null;
	// Only a *loaded* list can prove a site is absent; mid-flight there is nothing to conclude.
	const missing = Boolean(siteId) && Boolean(sites.data) && !selected;

	return (
		<div className="space-y-6">
			<AppearancePanel />
			<SessionPanel />

			<div className="surface flex flex-wrap items-center justify-between gap-3 rounded-xl p-4">
				<div className="flex items-start gap-2.5">
					<ShieldAlert
						className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--warn)]"
						aria-hidden="true"
					/>
					<div>
						<p className="font-medium text-[color:var(--ink)] text-sm">
							Admin session active
						</p>
						<p className="max-w-prose text-[color:var(--muted)] text-xs">
							This token grants admin access to <strong>every site</strong> in this
							deployment, not only the one selected below. It is held for this browser
							tab only and is cleared when the tab closes.
						</p>
					</div>
				</div>
				<button
					type="button"
					onClick={forgetToken}
					className="btn-ghost rounded-lg px-3 py-1.5 font-medium text-sm transition"
				>
					Forget admin token
				</button>
			</div>

			{rejected ? (
				<p role="alert" className="alert-error rounded-xl px-4 py-3 text-sm">
					<strong>The deployment rejected this admin token.</strong> It may have been
					rotated since this tab unlocked. Forget it above and enter the current
					ADMIN_TOKEN — nothing below it can load until you do.
				</p>
			) : null}

			{rejected ? null : (
				<SitesPanel token={token} onManageSite={setSiteId} activeSiteId={siteId} />
			)}

			{/* Deployment-wide like Sites, and deliberately above the site selection: a session belongs
			    to a person and to this whole deployment, so offering it inside the per-site tabs would
			    imply revoking it were somehow scoped to the site being managed. */}
			{rejected ? null : <OperatorSessionsPanel token={token} />}

			{rejected ? null : siteId ? (
				<div className="space-y-4">
					<div className="surface-2 sticky top-2 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3">
						<div className="min-w-0">
							<p data-chrome className="text-[color:var(--faint)] text-[11px]">
								Managing site
							</p>
							<p className="truncate font-medium text-[color:var(--ink)] text-sm">
								{selected ? selected.name : 'Selected site'}
								{selected ? (
									<span className="ml-1.5 font-normal text-[color:var(--muted)]">
										{selected.domain}
									</span>
								) : null}
							</p>
							<code
								data-selectable
								className="block truncate font-mono text-[color:var(--faint)] text-[11px]"
							>
								{siteId}
							</code>
						</div>
						<div className="ml-auto flex items-center gap-2">
							<button
								type="button"
								onClick={() => setSiteId('')}
								className="btn-ghost rounded-md px-2.5 py-1 font-medium text-xs transition"
							>
								Change site
							</button>
						</div>
					</div>

					{missing ? (
						<p
							role="alert"
							className="alert-warn flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
						>
							<AlertTriangle
								className="mt-0.5 h-3.5 w-3.5 shrink-0"
								aria-hidden="true"
							/>
							<span>
								This site id is not in this deployment&rsquo;s site list. It may
								have come from a saved profile pointing at a different deployment —
								the panels below will come back empty.
							</span>
						</p>
					) : null}

					<div
						role="tablist"
						aria-label="Site settings sections"
						className="flex flex-wrap gap-1"
					>
						{SECTIONS.map((s) => (
							<button
								key={s.id}
								type="button"
								role="tab"
								id={`settings-tab-${s.id}`}
								aria-selected={section === s.id}
								aria-controls={`settings-panel-${s.id}`}
								tabIndex={section === s.id ? 0 : -1}
								onKeyDown={(e) => {
									if (onTabKey(e.key, s.id, setSection)) e.preventDefault();
								}}
								onClick={() => setSection(s.id)}
								className={cn(
									'rounded-lg border px-3 py-1.5 font-medium text-xs transition',
									section === s.id
										? 'chip-active'
										: 'border-[color:rgb(var(--border))] text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]',
								)}
							>
								{s.label}
							</button>
						))}
					</div>

					{/*
					  Keyed by site id so every panel's local draft state is thrown away when the
					  managed site changes. Without this React reuses the same instances across the
					  switch, and a draft raised against site A is submitted with site B's id — the
					  issued-key banner would offer to save site A's plaintext key under site B, and
					  a flag opened for edit under site A would PATCH into site B.
					*/}
					<div
						key={siteId}
						role="tabpanel"
						id={`settings-panel-${section}`}
						aria-labelledby={`settings-tab-${section}`}
					>
						{section === 'keys' ? <KeysPanel token={token} siteId={siteId} /> : null}
						{section === 'goals' ? <GoalsPanel token={token} siteId={siteId} /> : null}
						{section === 'funnels' ? (
							<FunnelsPanel token={token} siteId={siteId} />
						) : null}
						{section === 'experiments' ? (
							<ExperimentsPanel token={token} siteId={siteId} />
						) : null}
						{section === 'flags' ? <FlagsPanel token={token} siteId={siteId} /> : null}
						{section === 'alerts' ? (
							<AlertsPanel token={token} siteId={siteId} />
						) : null}
						{section === 'identity' ? (
							<IdentityPanel token={token} siteId={siteId} />
						) : null}
					</div>
				</div>
			) : (
				<p className="surface rounded-xl p-5 text-center text-[color:var(--muted)] text-sm">
					Pick a site above with <strong>Manage</strong> to set up its API keys, goals,
					funnels, experiments, flags, alerts and identity tier.
				</p>
			)}
		</div>
	);
}

/**
 * Roving-tabindex arrow navigation, as the tablist role promises to assistive tech.
 * Returns true when the key was consumed, so the caller can suppress the page scroll.
 */
function onTabKey(key: string, current: SectionId, select: (id: SectionId) => void): boolean {
	const index = SECTIONS.findIndex((s) => s.id === current);
	if (index < 0) return false;
	let next: number;
	if (key === 'ArrowRight') next = (index + 1) % SECTIONS.length;
	else if (key === 'ArrowLeft') next = (index - 1 + SECTIONS.length) % SECTIONS.length;
	else if (key === 'Home') next = 0;
	else if (key === 'End') next = SECTIONS.length - 1;
	else return false;
	const target = SECTIONS[next];
	if (!target) return false;
	select(target.id);
	document.getElementById(`settings-tab-${target.id}`)?.focus();
	return true;
}
