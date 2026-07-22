// Self-service admin area. Manages sites, API keys, goals, funnels, and experiments via the
// admin API. The ADMIN_TOKEN is entered here and kept in memory/sessionStorage only (never mixed
// with the site-credential store, never in a URL/log). All mutations invalidate the relevant list.

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useAdmin } from '../admin.js';
import { useDashboard } from '../state.js';
import { AdminTokenGate } from './settings/AdminTokenGate.js';
import { ExperimentsPanel } from './settings/ExperimentsPanel.js';
import { FlagsPanel } from './settings/FlagsPanel.js';
import { FunnelsPanel } from './settings/FunnelsPanel.js';
import { GoalsPanel } from './settings/GoalsPanel.js';
import { IdentityPanel } from './settings/IdentityPanel.js';
import { KeysPanel } from './settings/KeysPanel.js';
import { SitesPanel } from './settings/SitesPanel.js';

export function Settings(): ReactElement {
	const { hasToken, token, forgetToken } = useAdmin();
	const { activeProfile } = useDashboard();
	const [siteId, setSiteId] = useState<string>(activeProfile?.siteId ?? '');

	if (!hasToken) {
		return <AdminTokenGate />;
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
				<div>
					<p className="text-sm font-medium text-neutral-800">Admin session active</p>
					<p className="text-xs text-neutral-500">
						This token grants deployment-wide admin access. It is stored for this
						browser tab only.
					</p>
				</div>
				<button
					type="button"
					onClick={forgetToken}
					className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
				>
					Forget admin token
				</button>
			</div>

			<SitesPanel token={token} onManageSite={setSiteId} activeSiteId={siteId} />

			{siteId ? (
				<div className="space-y-6">
					<KeysPanel token={token} siteId={siteId} />
					<GoalsPanel token={token} siteId={siteId} />
					<FunnelsPanel token={token} siteId={siteId} />
					<ExperimentsPanel token={token} siteId={siteId} />
					<FlagsPanel token={token} siteId={siteId} />
					<IdentityPanel token={token} siteId={siteId} />
				</div>
			) : (
				<p className="rounded-xl border border-neutral-200 bg-white p-5 text-center text-sm text-neutral-500 shadow-sm">
					Create or select a site above to manage its keys, goals, funnels, experiments,
					and flags.
				</p>
			)}
		</div>
	);
}
