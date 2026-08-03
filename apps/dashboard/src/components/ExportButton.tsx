// Export control: downloads a CSV from /api/stats/export preserving the active site + range +
// hostname filter. Offers a time-series export or a breakdown by a chosen dimension.

import type { Interval } from '@facet/shared';
import { Download } from 'lucide-react';
import { type ReactElement, useCallback, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { type ExportKind, downloadExport } from '../lib/download.js';
import { usePopoverDismiss } from '../lib/usePopoverDismiss.js';
import type { Range } from '../state.js';

const BREAKDOWN_DIMENSIONS = [
	{ value: 'path', label: 'Top pages' },
	{ value: 'referrer', label: 'Top referrers' },
	{ value: 'country', label: 'Countries' },
	{ value: 'device', label: 'Devices' },
] as const;

export function ExportButton({
	apiKey,
	siteId,
	range,
	interval,
	hostname,
	dark = false,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
	interval?: Interval;
	hostname?: string;
	dark?: boolean;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuId = useId();

	// Was outside-click only: Escape did not close it and focus never returned to the trigger.
	const close = useCallback(() => setOpen(false), []);
	usePopoverDismiss(open, close, ref, triggerRef);

	async function run(kind: ExportKind, dimension?: string): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await downloadExport(apiKey, {
				siteId,
				range,
				kind,
				format: 'csv',
				dimension,
				hostname,
				interval: kind === 'series' ? interval : undefined,
			});
			setOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'export_failed');
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="relative" ref={ref}>
			<button
				ref={triggerRef}
				type="button"
				disabled={!siteId || busy}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-controls={open ? menuId : undefined}
				onClick={() => setOpen((v) => !v)}
				className={cn(
					'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50',
					dark
						? 'border-[color:rgb(var(--border))] text-[color:var(--faint)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]'
						: 'border-[color:rgb(var(--border))] text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]',
				)}
			>
				<Download className="h-4 w-4" aria-hidden="true" />
				{busy ? 'Exporting…' : 'Export CSV'}
			</button>
			{open ? (
				<div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-[color:rgb(var(--border))] bg-[var(--panel)] p-1.5 shadow-lg">
					{/* The trigger says aria-haspopup="menu", so this has to actually be one, and it
					    may own nothing but menuitems — the error line therefore lives outside it. The
					    breakdown items also need names that stand alone: "Top pages" on its own reads
					    as a link to a report, not as "export a breakdown by page". */}
					<div id={menuId} role="menu" aria-label="Export CSV">
						<button
							type="button"
							role="menuitem"
							onClick={() => run('series')}
							className="block w-full rounded-lg px-3 py-2 text-left text-sm text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]"
						>
							Time series
						</button>
						<hr className="my-1 border-[color:rgb(var(--border))] border-t" />
						<p
							role="presentation"
							className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-[color:var(--muted)]"
						>
							Breakdown
						</p>
						{BREAKDOWN_DIMENSIONS.map((d) => (
							<button
								key={d.value}
								type="button"
								role="menuitem"
								aria-label={`Breakdown by ${d.label}`}
								onClick={() => run('breakdown', d.value)}
								className="block w-full rounded-lg px-3 py-2 text-left text-sm text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]"
							>
								{d.label}
							</button>
						))}
					</div>
					{error ? (
						<p role="alert" className="px-3 py-1.5 text-neg text-xs">
							Export failed: {error}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
