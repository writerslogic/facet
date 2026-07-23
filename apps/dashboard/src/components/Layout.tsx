// App shell: header with brand, the site-profile switcher, a Settings toggle, and the date-range
// control. Profiles are managed from the switcher; there is no single-credential sign-out anymore.

import { Settings as SettingsIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { DateRange } from './DateRange.js';
import { SiteSwitcher } from './SiteSwitcher.js';

/** The Facet brand mark: a faceted gem on the indigo→violet gradient. Reused by the header and the
 * key gate so the identity is consistent. Sized by the caller via `className`. */
export function BrandMark({ className }: { className?: string }): ReactElement {
	return (
		<span
			className={cn(
				'inline-flex items-center justify-center rounded-[10px] bg-brand-gradient text-white shadow-card ring-1 ring-white/20',
				className ?? 'size-8',
			)}
			aria-hidden="true"
		>
			<svg viewBox="0 0 24 24" className="size-1/2" fill="none" aria-hidden="true">
				<path d="M12 3 20 9 12 21 4 9z" fill="currentColor" opacity="0.95" />
				<path d="M12 3 12 21 4 9z" fill="currentColor" opacity="0.55" />
				<path d="M4 9h16" stroke="rgb(30 27 75 / 0.35)" strokeWidth="0.75" />
			</svg>
		</span>
	);
}

export function Layout({
	children,
	onToggleSettings,
	settingsActive,
	headerExtra,
	fill = false,
}: {
	children: ReactNode;
	onToggleSettings: () => void;
	settingsActive: boolean;
	headerExtra?: ReactNode;
	/** Fill the viewport exactly with no page scroll (the bento board owns its own internal scroll).
	 * Off for scrolling tabs (Settings, Retention, …), which keep normal page flow. */
	fill?: boolean;
}): ReactElement {
	return (
		<div
			className={cn(
				'text-neutral-900',
				fill ? 'flex h-dvh flex-col overflow-hidden' : 'min-h-screen',
			)}
		>
			<header
				className={cn(
					'z-10 border-b border-neutral-200/70 bg-white/70 backdrop-blur-xl',
					fill ? 'shrink-0' : 'sticky top-0',
				)}
			>
				<div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-6 py-3">
					<div className="flex items-center gap-3">
						<span className="flex items-center gap-2">
							<BrandMark />
							<span className="text-lg font-semibold tracking-[-0.02em]">Facet</span>
						</span>
						<SiteSwitcher />
					</div>
					<div className="flex flex-wrap items-center gap-3">
						{settingsActive ? null : <DateRange />}
						{headerExtra}
						<button
							type="button"
							onClick={onToggleSettings}
							aria-pressed={settingsActive}
							className={cn(
								'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition',
								settingsActive
									? 'border-accent-500 bg-accent-50 text-accent-700'
									: 'border-neutral-200 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900',
							)}
						>
							<SettingsIcon className="h-4 w-4" aria-hidden="true" />
							Settings
						</button>
					</div>
				</div>
			</header>
			<main
				className={cn(
					'mx-auto w-full max-w-[1600px] px-6',
					fill ? 'flex min-h-0 flex-1 flex-col overflow-hidden py-4' : 'py-6',
				)}
			>
				{children}
			</main>
		</div>
	);
}
