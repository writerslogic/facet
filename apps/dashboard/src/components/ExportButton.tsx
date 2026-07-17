// Export control: downloads a CSV from /api/stats/export preserving the active site + range +
// hostname filter. Offers a time-series export or a breakdown by a chosen dimension.

import type { Interval } from '@facet/shared';
import { Download } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { type ExportKind, downloadExport } from '../lib/download.js';
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
}: {
	apiKey: string;
	siteId: string;
	range: Range;
	interval?: Interval;
	hostname?: string;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		function onDoc(ev: MouseEvent): void {
			if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
		}
		document.addEventListener('mousedown', onDoc);
		return () => document.removeEventListener('mousedown', onDoc);
	}, [open]);

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
				type="button"
				disabled={!siteId || busy}
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50"
			>
				<Download className="h-4 w-4" aria-hidden="true" />
				{busy ? 'Exporting…' : 'Export CSV'}
			</button>
			{open ? (
				<div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-lg">
					<button
						type="button"
						onClick={() => run('series')}
						className="block w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
					>
						Time series
					</button>
					<div className="my-1 border-t border-neutral-100" />
					<p className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
						Breakdown
					</p>
					{BREAKDOWN_DIMENSIONS.map((d) => (
						<button
							key={d.value}
							type="button"
							onClick={() => run('breakdown', d.value)}
							className="block w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
						>
							{d.label}
						</button>
					))}
					{error ? (
						<p role="alert" className="px-3 py-1.5 text-xs text-red-600">
							Export failed: {error}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
