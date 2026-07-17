// Shared, accessible status UI: loading skeleton, auth-error banner, general-error block with a
// safe expandable detail (no secrets), empty state, and the hourly session-materialization notice.
// Color is always paired with text/icon so status is never color-only.

import { AlertTriangle, Clock, Inbox, KeyRound } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';

/** Animated placeholder block for a not-yet-loaded region. */
export function Skeleton({ className }: { className?: string }): ReactElement {
	return (
		<div
			className={cn('animate-pulse rounded-lg bg-neutral-100', className)}
			aria-hidden="true"
		/>
	);
}

/** Card-shaped loading skeleton grid used across tabs. */
export function CardSkeletons({ count = 3 }: { count?: number }): ReactElement {
	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy="true">
			{Array.from({ length: count }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list with no identity
				<Skeleton key={i} className="h-24 w-full" />
			))}
		</div>
	);
}

/** Prominent, accessible banner for an unrecognized API key / site. */
export function AuthErrorBanner(): ReactElement {
	return (
		<div
			role="alert"
			aria-live="assertive"
			className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 shadow-sm"
		>
			<KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
			<div>
				<p className="font-semibold">API key not recognized</p>
				<p className="mt-0.5 text-red-700">
					Check that the API key and site are correct for this profile, then update them
					in the site switcher.
				</p>
			</div>
		</div>
	);
}

/** General (non-auth) error with a safe, expandable technical detail — never a secret. */
export function ErrorState({
	message,
	detail,
}: {
	message?: string;
	detail?: string | null;
}): ReactElement {
	return (
		<div
			role="alert"
			aria-live="polite"
			className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 shadow-sm"
		>
			<div className="flex items-start gap-3">
				<AlertTriangle
					className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
					aria-hidden="true"
				/>
				<div className="min-w-0">
					<p className="font-semibold">{message ?? 'Something went wrong'}</p>
					{detail ? (
						<details className="mt-1">
							<summary className="cursor-pointer text-xs text-amber-700 underline">
								Details
							</summary>
							<p className="mt-1 break-words font-mono text-xs text-amber-700">
								{detail}
							</p>
						</details>
					) : null}
				</div>
			</div>
		</div>
	);
}

/** Successful-zero / no-data-yet state, visually distinct from loading and error. */
export function EmptyState({
	title = 'No data yet',
	children,
}: {
	title?: string;
	children?: ReactElement | string;
}): ReactElement {
	return (
		<div className="rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
			<Inbox className="mx-auto h-6 w-6 text-neutral-300" aria-hidden="true" />
			<p className="mt-2 text-sm font-medium text-neutral-600">{title}</p>
			{children ? <div className="mt-1 text-sm text-neutral-400">{children}</div> : null}
		</div>
	);
}

/** Notice shown when session-derived data is materializing on the hourly cron (meta.pending). */
export function PendingNotice(): ReactElement {
	return (
		<div
			aria-live="polite"
			className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800"
		>
			<Clock className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" aria-hidden="true" />
			<span>
				Session data materializes hourly. Recent sessions, channels, funnels, and
				experiments may not appear yet.
			</span>
		</div>
	);
}
