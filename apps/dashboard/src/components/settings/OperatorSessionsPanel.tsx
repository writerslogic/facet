// Ending another operator's sessions, from the deployment admin token.
//
// Deployment-wide, not site-scoped, which is why it sits beside Sites rather than inside the per-site
// tabs: sessions belong to a person and to this whole deployment, and nothing about the act depends on
// which site is selected.
//
// WHY A FREE-TEXT ID and not a picker. There is no user directory to pick from — team admins have no
// user-management surface at all yet, by design, and this route is behind ADMIN_TOKEN precisely
// because it would otherwise be the first cross-user action arriving without any of that structure.
// The access log in the CRM tab is where operator ids actually come from: it shows each actor's id,
// marks it selectable, and carries the full value in the button's title when the column truncates.

import { LogOut } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useRevokeUserSessions } from '../../hooks/admin.js';
import { BlockedReason, ConfirmDelete, Field, MutationStatus, Panel } from './kit.js';

/**
 * The server answers `404` for an id that matches no user, deliberately, so that a mistyped id is not
 * reported as a revocation that never happened. Rendered as `Error: not_found` that distinction is
 * technically preserved and practically invisible, so it gets the sentence it was separated for.
 */
function revokeError(error: unknown): unknown {
	if (error instanceof Error && error.message === 'not_found') {
		return new Error('no operator on this deployment has that id — nothing was revoked');
	}
	return error;
}

export function OperatorSessionsPanel({ token }: { token: string }): ReactElement {
	const [userId, setUserId] = useState('');
	const revoke = useRevokeUserSessions(token);
	const trimmed = userId.trim();

	return (
		<Panel
			title="Operator sessions"
			description="End every session one operator holds, across every device. Deployment-wide, not tied to the site selected below."
		>
			<div className="flex flex-wrap items-end gap-3">
				<div className="min-w-0 flex-1 basis-72">
					<Field
						id="admin-revoke-user"
						label="Operator user id"
						value={userId}
						onChange={(next) => {
							setUserId(next);
							// Otherwise the previous outcome sits under a field that no longer names
							// the operator it was reporting on.
							if (revoke.isSuccess || revoke.isError) revoke.reset();
						}}
						placeholder="00000000-0000-0000-0000-000000000000"
						hint="From the Who column of the access log in the CRM tab. There is no user directory yet."
					/>
				</div>
				{trimmed ? (
					<ConfirmDelete
						onConfirm={() => revoke.mutate(trimmed)}
						label="Revoke sessions"
						confirmLabel="Revoke sessions"
						consequence="Signs this operator out of every device immediately."
						busy={revoke.isPending}
						icon={LogOut}
					/>
				) : (
					<BlockedReason reason="Enter an operator id to revoke their sessions." />
				)}
			</div>

			<MutationStatus
				isPending={revoke.isPending}
				error={revoke.error ? revokeError(revoke.error) : null}
				success={
					revoke.isSuccess && revoke.data
						? `Every session for ${revoke.data.user_id} has ended.`
						: null
				}
				pendingLabel="Ending their sessions…"
			/>

			<p className="mt-3 max-w-prose text-[color:var(--muted)] text-xs">
				This is <strong>not</strong> a lockout. The account, its team roles and its data are
				untouched — the person can sign in again with a new magic link straight away. What
				it ends is every token currently issued to them, which is the remedy when a session
				may have been taken and the one thing the operator themselves is the wrong person to
				perform. Running it twice is harmless and has the same result as running it once.
			</p>
		</Panel>
	);
}
