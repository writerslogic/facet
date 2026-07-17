// App shell: header with brand, the site-profile switcher, a Settings toggle, and the date-range
// control. Profiles are managed from the switcher; there is no single-credential sign-out anymore.

import { Settings as SettingsIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { DateRange } from './DateRange.js';
import { SiteSwitcher } from './SiteSwitcher.js';

export function Layout({
	children,
	onToggleSettings,
	settingsActive,
}: {
	children: ReactNode;
	onToggleSettings: () => void;
	settingsActive: boolean;
}): ReactElement {
	return (
		<div className="min-h-screen bg-neutral-50 text-neutral-900">
			<header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 backdrop-blur">
				<div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
					<div className="flex items-center gap-3">
						<span className="text-lg font-semibold tracking-tight">Facet</span>
						<SiteSwitcher />
					</div>
					<div className="flex items-center gap-3">
						{settingsActive ? null : <DateRange />}
						<button
							type="button"
							onClick={onToggleSettings}
							aria-pressed={settingsActive}
							className={cn(
								'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition',
								settingsActive
									? 'border-sky-500 bg-sky-50 text-sky-700'
									: 'border-neutral-200 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900',
							)}
						>
							<SettingsIcon className="h-4 w-4" aria-hidden="true" />
							Settings
						</button>
					</div>
				</div>
			</header>
			<main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
		</div>
	);
}
