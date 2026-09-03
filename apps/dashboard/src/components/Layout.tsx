// App shell: header with brand, the site-profile switcher, a Settings toggle, and the date-range
// control. Profiles are managed from the switcher; there is no single-credential sign-out anymore.

import { Ellipsis, Settings as SettingsIcon } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { usePopoverDismiss } from '../lib/usePopoverDismiss.js';
import { ClockToggle } from './ClockToggle.js';
import { DateRange } from './DateRange.js';
import { ShortcutHelpButton } from './ShortcutHelp.js';
import { SiteSwitcher } from './SiteSwitcher.js';

/** The Facet brand mark — the same faceted-starburst logo as the README. The white variant shows on the
 * dark UI, the black on light (swapped by `[data-mode]` via the `facet-logo-on-*` classes in index.css).
 * Reused by the header and the key gate so the identity is consistent. Sized by the caller via `className`. */
// Asset URLs are resolved against Vite's BASE_URL, not the site root. The GitHub Pages demo builds
// with FACET_BASE=/facet/, which emits these files at /facet/logo-*.png; a root-absolute "/logo-*.png"
// therefore 404s there, which is exactly what was happening on the live demo.
export function BrandMark({ className }: { className?: string }): ReactElement {
	return (
		<span className={cn('inline-flex items-center justify-center', className ?? 'size-8')}>
			<img
				src={`${import.meta.env.BASE_URL}logo-white.png`}
				alt=""
				className="facet-logo-on-dark size-full object-contain"
				aria-hidden="true"
			/>
			<img
				src={`${import.meta.env.BASE_URL}logo-black.png`}
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
	onOpenShortcuts,
	shortcutsOpen = false,
}: {
	children: ReactNode;
	onToggleSettings: () => void;
	settingsActive: boolean;
	headerExtra?: ReactNode;
	/** Opens the keyboard-shortcut overlay. The visible button is the discovery route for every
	 * shortcut in it — a keyboard layer whose only door is a keystroke is not discoverable. */
	onOpenShortcuts?: () => void;
	shortcutsOpen?: boolean;
	/** Fill the viewport exactly with no page scroll (the bento board owns its own internal scroll).
	 * Off for scrolling tabs (Settings, Retention, …), which keep normal page flow. */
	fill?: boolean;
	/** Dark "cut obsidian" shell for the Overview marketing surface — ink background + light chrome. */
	dark?: boolean;
}): ReactElement {
	const [compactHeader, setCompactHeader] = useState(false);
	const [phoneHeader, setPhoneHeader] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const moreWrapRef = useRef<HTMLDivElement>(null);
	const moreToggleRef = useRef<HTMLButtonElement>(null);
	usePopoverDismiss(moreOpen, () => setMoreOpen(false), moreWrapRef, moreToggleRef);
	useEffect(() => {
		const measure = (): void => {
			setCompactHeader(window.innerWidth < 1200);
			setPhoneHeader(window.innerWidth < 680);
		};
		measure();
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	}, []);
	useEffect(() => {
		if (!compactHeader) setMoreOpen(false);
	}, [compactHeader]);

	return (
		<div
			className={cn(
				fill ? 'flex h-dvh flex-col overflow-hidden' : 'min-h-screen',
				dark ? 'facet-dark text-[color:var(--ink)]' : 'text-[color:var(--ink)]',
			)}
		>
			{/* The header + the nine-tab strip repeat on every view, so a keyboard reader hits nine stops
			    before the first control that belongs to the page (WCAG 2.4.1). This is the bypass. */}
			<a
				data-chrome
				href="#facet-main"
				className="surface -translate-x-1/2 sr-only left-1/2 z-50 rounded-lg px-4 py-2 font-medium text-[color:var(--ink)] text-sm focus:not-sr-only focus:fixed focus:top-2"
			>
				Skip to main content
			</a>
			{/* z-20, not z-10: the header owns three popovers (site switcher, date range, export) and the
			    board's own tile headers are also z-10 positioned children of <main>. On equal z-index the
			    later element in the DOM wins, so the site menu was painted UNDER the first tile's header
			    and its lower rows could not be clicked at all. */}
			<header
				className={cn(
					'z-20 border-b backdrop-blur-xl',
					dark
						? 'border-[color:rgb(var(--border))] bg-[var(--bg)]'
						: 'border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))]',
					fill ? 'shrink-0' : 'sticky top-0',
				)}
			>
				<div className="mx-auto flex max-w-[1600px] items-center justify-between gap-2 px-3 py-2 sm:gap-3 sm:px-6">
					<div className="flex items-center gap-3">
						<span data-chrome className="flex items-center gap-2">
							<BrandMark />
							<span className="hidden text-prism text-lg font-semibold tracking-[-0.02em] sm:inline">
								Facet
							</span>
						</span>
						<SiteSwitcher />
					</div>
					<div className="flex shrink-0 items-center gap-2 sm:gap-3">
						{settingsActive || phoneHeader ? null : <DateRange dark={dark} />}
						{compactHeader ? (
							<div className="relative" ref={moreWrapRef}>
								<button
									ref={moreToggleRef}
									type="button"
									onClick={() => setMoreOpen((open) => !open)}
									aria-label="More dashboard actions"
									aria-haspopup="dialog"
									aria-expanded={moreOpen}
									title="More dashboard actions"
									className="flex size-9 items-center justify-center rounded-lg border border-[color:rgb(var(--border))] text-[color:var(--muted)] transition hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
								>
									<Ellipsis className="h-4 w-4" aria-hidden="true" />
								</button>
								{moreOpen ? (
									<dialog
										open
										aria-label="More dashboard actions"
										className="absolute right-0 z-40 m-0 mt-1 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col items-stretch gap-1 rounded-xl border border-[color:rgb(var(--border))] bg-[var(--panel)] p-2 shadow-float"
									>
										{phoneHeader && !settingsActive ? (
											<DateRange dark={dark} />
										) : null}
										{/* The clock remains adjacent in the wide header; here its explicit label
										    makes the same state discoverable without forcing a second header row. */}
										<ClockToggle />
										{headerExtra}
										{onOpenShortcuts ? (
											<ShortcutHelpButton
												onOpen={() => {
													setMoreOpen(false);
													onOpenShortcuts();
												}}
												open={shortcutsOpen}
											/>
										) : null}
									</dialog>
								) : null}
							</div>
						) : (
							<>
								{/* The standing statement of which clock the whole app is in. Next to the
								    date range on purpose: together they are "which window, on which clock". */}
								<ClockToggle />
								{headerExtra}
								{onOpenShortcuts ? (
									<ShortcutHelpButton
										onOpen={onOpenShortcuts}
										open={shortcutsOpen}
									/>
								) : null}
							</>
						)}
						<button
							type="button"
							onClick={onToggleSettings}
							aria-pressed={settingsActive}
							aria-label="Settings"
							className={cn(
								'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm font-medium transition sm:px-3',
								settingsActive
									? 'chip-active'
									: dark
										? 'border-[color:rgb(var(--border))] text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]'
										: 'border-[color:rgb(var(--border))] text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]',
							)}
						>
							<SettingsIcon className="h-4 w-4" aria-hidden="true" />
							<span className="hidden sm:inline" aria-hidden="true">
								Settings
							</span>
						</button>
					</div>
				</div>
			</header>
			<main
				id="facet-main"
				className={cn(
					'mx-auto w-full max-w-[1600px] px-3 sm:px-6',
					// The fixed "Powered by Facet" badge sits bottom-right; scrolling tabs reserve room
					// under the content so it can't cover the last control on the page (it was landing
					// on the Settings panels' action buttons).
					fill ? 'flex min-h-0 flex-1 flex-col overflow-hidden py-2.5' : 'pt-6 pb-12',
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
	// Wrapped in a <footer> so it is inside a landmark: as a bare fixed <a> it was the one piece of
	// content on every single view that a landmark-navigating screen reader could never reach.
	return (
		<footer data-chrome className="fixed right-3 bottom-2 z-40" aria-label="Facet attribution">
			<a
				href="https://github.com/writerslogic/facet"
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex items-center gap-1 rounded-full bg-[color:rgb(var(--hover))] px-2 py-0.5 text-[10px] text-[color:var(--muted)] ring-1 ring-[color:rgb(var(--border))] backdrop-blur transition hover:text-[color:var(--ink)]"
			>
				<BrandMark className="size-3" />
				Powered by Facet
			</a>
		</footer>
	);
}
