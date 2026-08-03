// Shared, accessible status UI: loading skeleton, auth-error banner, general-error block with a
// safe expandable detail (no secrets), empty state, and the hourly session-materialization notice.
// Color is always paired with text/icon so status is never color-only, and every surface reads the
// theme tokens so these states match the active palette in both light and dark.

import { AlertTriangle, Clock, Inbox, KeyRound, RotateCw } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/** Animated placeholder block for a not-yet-loaded region. */
export function Skeleton({ className }: { className?: string }): ReactElement {
	return <div className={cn('shimmer rounded-lg', className)} aria-hidden="true" />;
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
			className="alert-error flex items-start gap-3 rounded-xl p-4 text-sm"
		>
			<KeyRound className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
			<div>
				<p className="font-semibold">API key not recognized</p>
				<p className="mt-0.5 opacity-90">
					An API key is bound to one site. Check that this profile pairs the right key
					with the right Site ID, then fix it from the site menu in the header.
				</p>
			</div>
		</div>
	);
}

/**
 * General (non-auth) error with a safe, expandable technical detail — never a secret.
 *
 * `onRetry` exists because most failed reads in this app dead-ended: the All-sites table grew a
 * per-row retry, and every other tab left the reader with a sentence and a page refresh as the only
 * way forward. A transient 5xx or a dropped connection is the common case, and it is one click.
 */
export function ErrorState({
	message,
	detail,
	onRetry,
	retrying = false,
}: {
	message?: string;
	detail?: string | null;
	/** Re-run the failed query. Omit when the failure is not retryable (a rejected key, say). */
	onRetry?: () => void;
	retrying?: boolean;
}): ReactElement {
	return (
		<div role="alert" aria-live="polite" className="alert-warn rounded-xl p-4 text-sm">
			<div className="flex items-start gap-3">
				<AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<p className="font-semibold">{message ?? 'Something went wrong'}</p>
					{detail ? (
						<details className="mt-1">
							<summary className="cursor-pointer text-xs underline opacity-80">
								Details
							</summary>
							<p
								data-selectable
								className="mt-1 break-words font-mono text-xs opacity-80"
							>
								{detail}
							</p>
						</details>
					) : null}
				</div>
				{onRetry ? (
					<button
						type="button"
						data-chrome
						onClick={onRetry}
						disabled={retrying}
						className="btn-ghost inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium text-xs transition"
					>
						<RotateCw
							className={cn('h-3.5 w-3.5', retrying && 'animate-spin')}
							aria-hidden="true"
						/>
						{retrying ? 'Retrying…' : 'Retry'}
					</button>
				) : null}
			</div>
		</div>
	);
}

/** Successful-zero / no-data-yet state, visually distinct from loading and error. */
export function EmptyState({
	title = 'No data yet',
	children,
	action,
}: {
	title?: string;
	children?: ReactNode;
	/** Optional call-to-action so an empty tab points at the next step instead of dead-ending. */
	action?: ReactNode;
}): ReactElement {
	return (
		<div className="surface rounded-2xl p-10 text-center">
			<span
				className="mx-auto flex size-12 items-center justify-center rounded-full"
				style={{
					backgroundColor: 'var(--chip-bg)',
					boxShadow: 'inset 0 0 0 1px var(--chip-border)',
				}}
			>
				<Inbox
					className="h-6 w-6"
					style={{ color: 'var(--chip-ink)' }}
					aria-hidden="true"
				/>
			</span>
			<p className="mt-3 font-semibold text-[color:var(--ink)] text-sm">{title}</p>
			{children ? (
				<div className="mt-1 text-[color:var(--muted)] text-sm">{children}</div>
			) : null}
			{action ? <div className="mt-4 flex justify-center">{action}</div> : null}
		</div>
	);
}

/** Notice shown when session-derived data is materializing on the hourly cron (meta.pending). */
export function PendingNotice(): ReactElement {
	return (
		<div
			aria-live="polite"
			className="alert-info flex items-start gap-2 rounded-lg p-3 text-sm"
		>
			<Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			<span>
				Session data materializes hourly. Recent sessions, channels, funnels, and
				experiments may not appear yet.
			</span>
		</div>
	);
}
