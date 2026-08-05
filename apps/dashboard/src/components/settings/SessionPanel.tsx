// The operator's own account session, and the one control that ends it everywhere.
//
// Session auth is a different axis from the rest of Settings: everything below the admin gate is
// authorized by ADMIN_TOKEN and scoped to a selected site, whereas this is authorized by the person's
// own cookie and is scoped to them. So it renders OUTSIDE the gate, beside Appearance, and never
// inside the per-site tabs — a control that ends your sessions has nothing to do with which site is
// selected, and putting it there would imply it did.
//
// RENDERS NOTHING unless a session actually resolves. A deployment with no `SESSION_SECRET` has no
// accounts at all, and most Facet deployments are exactly that — API keys and no operator sign-in —
// so an "account" panel permanently explaining that it cannot be used is noise on the common path.
// Signed out is the same: there is no session to end. Both are answers from `/api/auth/me`, which is
// why the panel waits for it rather than guessing from the presence of a cookie it cannot read.

import { LogOut } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useLogoutEverywhere, useSessionMe } from '../../hooks/session.js';
import { ConfirmDelete, MutationStatus, Panel } from './kit.js';

export function SessionPanel(): ReactElement | null {
	const me = useSessionMe();
	const logout = useLogoutEverywhere();
	// Survives the query going 401 immediately afterwards, which is exactly what success looks like:
	// `/api/auth/me` stops resolving the moment the epoch moves, so a panel driven only by the query
	// would replace the confirmation with an empty space and leave the operator unsure it worked.
	const [done, setDone] = useState(false);

	if (done) {
		return (
			<Panel title="Signed out everywhere">
				<div className="space-y-2 text-[color:var(--muted)] text-sm">
					<p>
						Every session on this account has ended, on every device and in every
						browser — including this one. Any token copied out of a browser stopped
						working at the same moment.
					</p>
					<p>
						This tab is still showing what it loaded before that. Reload and sign in
						again with a fresh magic link.
					</p>
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="btn-ghost rounded-lg px-3 py-1.5 font-medium text-sm transition"
					>
						Reload
					</button>
				</div>
			</Panel>
		);
	}

	// Checked field by field rather than trusted from a 200. This panel renders inside Settings, so a
	// response that parsed but is not the shape this build expects — a proxy's own page, a later
	// server, an SSO portal answering everything with a login form — would otherwise throw during
	// render and take the whole admin area down with it. None of those is a session to act on, which
	// is the same answer as being signed out.
	const user = me.data?.user;
	if (!user?.email) return null;

	return (
		<Panel
			title="Your account"
			description="The operator session this browser is signed in with. Separate from the site API keys and from the admin token."
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p
						data-selectable
						className="truncate font-medium text-[color:var(--ink)] text-sm"
					>
						{user.name ?? user.email}
					</p>
					{user.name ? (
						<p data-selectable className="truncate text-[color:var(--muted)] text-xs">
							{user.email}
						</p>
					) : null}
					<code
						data-selectable
						className="mt-0.5 block truncate font-mono text-[color:var(--faint)] text-[11px]"
					>
						{user.id}
					</code>
				</div>
				<ConfirmDelete
					onConfirm={() => logout.mutate(undefined, { onSuccess: () => setDone(true) })}
					label="Sign out everywhere"
					confirmLabel="Sign out everywhere"
					consequence="Ends every session on this account, including this one."
					busy={logout.isPending}
					icon={LogOut}
				/>
			</div>

			<MutationStatus
				isPending={logout.isPending}
				error={logout.error}
				pendingLabel="Ending every session…"
			/>

			<p className="mt-3 max-w-prose text-[color:var(--muted)] text-xs">
				Closing this tab, or signing out normally, only clears the cookie in{' '}
				<strong>this</strong> browser. A session token already copied out of it keeps
				working for the rest of its thirty days, so if you think one has been taken,
				clearing the cookie is not a remedy — this is. There is no per-device list to choose
				from because Facet stores no sessions to list; the honest control is the one that
				ends all of them.
			</p>
		</Panel>
	);
}
