// App shell: header with brand, date-range control, and a sign-out action that clears the
// stored credentials.

import { LogOut } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useDashboard } from '../state.js';
import { DateRange } from './DateRange.js';

export function Layout({ children }: { children: ReactNode }): ReactElement {
	const { siteId, clearCredentials } = useDashboard();

	return (
		<div className="min-h-screen bg-neutral-50 text-neutral-900">
			<header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 backdrop-blur">
				<div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
					<div className="flex items-baseline gap-3">
						<span className="text-lg font-semibold tracking-tight">Facet</span>
						<span className="text-sm text-neutral-400">{siteId}</span>
					</div>
					<div className="flex items-center gap-3">
						<DateRange />
						<button
							type="button"
							onClick={clearCredentials}
							title="Sign out"
							className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
						>
							<LogOut className="h-4 w-4" aria-hidden="true" />
							Sign out
						</button>
					</div>
				</div>
			</header>
			<main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
		</div>
	);
}
