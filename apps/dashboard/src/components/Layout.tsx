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
	dark = false,
}: {
	children: ReactNode;
	onToggleSettings: () => void;
	settingsActive: boolean;
	headerExtra?: ReactNode;
	/** Fill the viewport exactly with no page scroll (the bento board owns its own internal scroll).
	 * Off for scrolling tabs (Settings, Retention, …), which keep normal page flow. */
	fill?: boolean;
	/** Dark "cut obsidian" shell for the Overview marketing surface — ink background + light chrome. */
	dark?: boolean;
}): ReactElement {
	return (
		<div
			className={cn(
				fill ? 'flex h-dvh flex-col overflow-hidden' : 'min-h-screen',
				dark ? 'facet-dark text-[color:var(--ink)]' : 'text-neutral-900',
			)}
		>
			<header
				className={cn(
					'z-10 border-b backdrop-blur-xl',
					dark
						? 'border-[color:rgb(var(--border))] bg-[var(--bg)]'
						: 'border-neutral-200/70 bg-[color:rgb(var(--hover))]',
					fill ? 'shrink-0' : 'sticky top-0',
				)}
			>
				<div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-6 py-2">
					<div className="flex items-center gap-3">
						<span className="flex items-center gap-2">
							<BrandMark />
							<span className="text-prism text-lg font-semibold tracking-[-0.02em]">
								Facet
							</span>
						</span>
						<SiteSwitcher dark={dark} />
					</div>
					<div className="flex flex-wrap items-center gap-3">
						{settingsActive ? null : <DateRange dark={dark} />}
						{headerExtra}
						<button
							type="button"
							onClick={onToggleSettings}
							aria-pressed={settingsActive}
							className={cn(
								'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition',
								settingsActive
									? 'border-accent-500 bg-accent-50 text-accent-700'
									: dark
										? 'border-[color:rgb(var(--border))] text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]'
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
					fill ? 'flex min-h-0 flex-1 flex-col overflow-hidden py-2.5' : 'py-6',
				)}
			>
				{children}
			</main>
		</div>
	);
}
