// App shell: header with brand, the site-profile switcher, a Settings toggle, and the date-range
// control. Profiles are managed from the switcher; there is no single-credential sign-out anymore.

import { Settings as SettingsIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { DateRange } from './DateRange.js';
import { SiteSwitcher } from './SiteSwitcher.js';

/** The Facet brand mark — the same faceted-starburst logo as the README. The white variant shows on the
 * dark UI, the black on light (swapped by `[data-mode]` via the `facet-logo-on-*` classes in index.css).
 * Reused by the header and the key gate so the identity is consistent. Sized by the caller via `className`. */
export function BrandMark({ className }: { className?: string }): ReactElement {
	return (
		<span className={cn('inline-flex items-center justify-center', className ?? 'size-8')}>
			<img
				src="/logo-white.png"
				alt=""
				className="facet-logo-on-dark size-full object-contain"
				aria-hidden="true"
			/>
			<img
				src="/logo-black.png"
				alt=""
				className="facet-logo-on-light size-full object-contain"
				aria-hidden="true"
			/>
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
			<PoweredBy />
		</div>
	);
}

/** True when this build is licensed to white-label (attribution suppressed). Set at build time via
 * `VITE_FACET_WHITE_LABEL=1`. AGPL builds leave it unset; removing attribution otherwise requires either
 * AGPL compliance (publish your source) or a commercial white-label license — see TRADEMARK.md. */
export function isWhiteLabel(): boolean {
	return import.meta.env.VITE_FACET_WHITE_LABEL === '1';
}

/** A small, unobtrusive "Powered by Facet" attribution, fixed bottom-right so it survives in both the
 * fill (Overview) and scrolling layouts. Deliberately a plain, integrated element — not obfuscated —
 * because under AGPL an operator may remove it by publishing their source, or hold a commercial license
 * to white-label (see TRADEMARK.md). Hidden when this build is white-labeled. */
export function PoweredBy(): ReactElement | null {
	if (isWhiteLabel()) return null;
	return (
		<a
			href="https://github.com/writerslogic/facet"
			target="_blank"
			rel="noopener noreferrer"
			className="fixed right-3 bottom-2 z-40 inline-flex items-center gap-1 rounded-full bg-[color:rgb(var(--hover))] px-2 py-0.5 text-[10px] text-[color:var(--muted)] ring-1 ring-[color:rgb(var(--border))] backdrop-blur transition hover:text-[color:var(--ink)]"
		>
			<BrandMark className="size-3" />
			Powered by Facet
		</a>
	);
}
