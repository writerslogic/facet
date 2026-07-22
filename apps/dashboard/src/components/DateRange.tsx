// Date-range control: preset chips, a custom start/end date range (validated against start<end and
// the 90-day server max), and a "compare with previous period" toggle. All timestamps are UTC.

import { CalendarRange } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import {
	RANGE_PRESETS,
	type RangePreset,
	formatDateInput,
	parseDateInput,
	useDashboard,
	validateCustomRange,
} from '../state.js';

const LABELS: Record<RangePreset, string> = {
	'24h': '24h',
	'7d': '7d',
	'30d': '30d',
	'90d': '90d',
};

function CustomPopover({ onClose }: { onClose: () => void }): ReactElement {
	const { selection, range, setCustomRange } = useDashboard();
	const [start, setStart] = useState(() =>
		formatDateInput(selection.kind === 'custom' ? selection.start : range.start),
	);
	const [end, setEnd] = useState(() =>
		formatDateInput(selection.kind === 'custom' ? selection.end : range.end),
	);
	const [error, setError] = useState<string | null>(null);

	function apply(): void {
		const s = parseDateInput(start);
		const e = parseDateInput(end);
		const err = validateCustomRange(s, e);
		if (err) {
			setError(err);
			return;
		}
		setCustomRange(s, e);
		onClose();
	}

	return (
		<div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-neutral-200 bg-white p-4 shadow-lg">
			<p className="mb-2 text-xs font-medium text-neutral-500">Custom range (UTC)</p>
			<div className="flex flex-col gap-3">
				<label className="text-xs font-medium text-neutral-600">
					Start
					<input
						type="date"
						value={start}
						onChange={(ev) => setStart(ev.target.value)}
						className="mt-1 block w-full rounded-lg border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-900 outline-none focus:border-accent-500 focus:ring-1 focus:ring-accent-500"
					/>
				</label>
				<label className="text-xs font-medium text-neutral-600">
					End
					<input
						type="date"
						value={end}
						onChange={(ev) => setEnd(ev.target.value)}
						className="mt-1 block w-full rounded-lg border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-900 outline-none focus:border-accent-500 focus:ring-1 focus:ring-accent-500"
					/>
				</label>
			</div>
			{error ? (
				<p role="alert" className="mt-2 text-xs text-red-600">
					{error}
				</p>
			) : null}
			<div className="mt-3 flex justify-end gap-2">
				<button
					type="button"
					onClick={onClose}
					className="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={apply}
					className="rounded-lg bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-700"
				>
					Apply
				</button>
			</div>
		</div>
	);
}

export function DateRange(): ReactElement {
	const { preset, setPreset, selection, compare, setCompare } = useDashboard();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const isCustom = selection.kind === 'custom';

	useEffect(() => {
		if (!open) return;
		function onDoc(ev: MouseEvent): void {
			if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
		}
		document.addEventListener('mousedown', onDoc);
		return () => document.removeEventListener('mousedown', onDoc);
	}, [open]);

	const customLabel = isCustom
		? `${formatDateInput(selection.start)} → ${formatDateInput(selection.end)}`
		: 'Custom';

	return (
		<div className="flex flex-wrap items-center gap-2">
			<div className="inline-flex rounded-lg border border-neutral-200/80 bg-neutral-100/70 p-0.5">
				{RANGE_PRESETS.map((option) => (
					<button
						key={option}
						type="button"
						aria-pressed={preset === option}
						onClick={() => setPreset(option)}
						className={cn(
							'tabular rounded-md px-3 py-1 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40',
							preset === option
								? 'bg-white text-accent-700 shadow-sm ring-1 ring-neutral-900/5'
								: 'text-neutral-500 hover:text-neutral-900',
						)}
					>
						{LABELS[option]}
					</button>
				))}
			</div>

			<div className="relative" ref={ref}>
				<button
					type="button"
					aria-pressed={isCustom}
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
					className={cn(
						'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition',
						isCustom
							? 'border-accent-500 bg-accent-50 text-accent-700'
							: 'border-neutral-200 text-neutral-600 hover:bg-neutral-100',
					)}
				>
					<CalendarRange className="h-4 w-4" aria-hidden="true" />
					<span className="max-w-[16ch] truncate">{customLabel}</span>
				</button>
				{open ? <CustomPopover onClose={() => setOpen(false)} /> : null}
			</div>

			<label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 has-[:checked]:border-accent-500 has-[:checked]:bg-accent-50 has-[:checked]:text-accent-700">
				<input
					type="checkbox"
					checked={compare}
					onChange={(ev) => setCompare(ev.target.checked)}
					className="h-3.5 w-3.5 rounded border-neutral-300 text-accent-600 focus:ring-accent-500"
				/>
				Compare
			</label>
		</div>
	);
}
