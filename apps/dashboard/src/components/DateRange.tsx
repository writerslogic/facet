// Date-range control: preset chips, a custom start/end date range (validated against start<end and
// the 90-day server max), and a "compare with previous period" toggle. All timestamps are UTC.

import { CalendarRange } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { usePopoverDismiss } from '../lib/usePopoverDismiss.js';
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

function CustomPopover({ id, onClose }: { id: string; onClose: () => void }): ReactElement {
	const { selection, range, setCustomRange } = useDashboard();
	const startRef = useRef<HTMLInputElement>(null);
	// Land on the first field when the popover opens; Escape then hands focus back to the trigger.
	useEffect(() => {
		startRef.current?.focus();
	}, []);
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
		// A named group, not a bare div: the two date fields and the two actions are one control, and
		// "Custom range (UTC)" is the only thing that says what applying them will do.
		<fieldset
			id={id}
			className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-[color:rgb(var(--border))] bg-[var(--panel)] p-4 shadow-lg"
		>
			<legend className="mb-2 font-medium text-[color:var(--muted)] text-xs">
				Custom range (UTC)
			</legend>
			<div className="flex flex-col gap-3">
				<label className="text-xs font-medium text-[color:var(--ink)]">
					Start
					{/* `.input` rather than the hand-rolled border: these two were the last controls off
					    the token, so they kept a ~1.2:1 boundary and a hardcoded accent focus ring. */}
					<input
						ref={startRef}
						type="date"
						value={start}
						onChange={(ev) => setStart(ev.target.value)}
						className="input mt-1 block w-full rounded-lg px-2.5 py-1.5 text-sm"
					/>
				</label>
				<label className="text-xs font-medium text-[color:var(--ink)]">
					End
					<input
						type="date"
						value={end}
						onChange={(ev) => setEnd(ev.target.value)}
						className="input mt-1 block w-full rounded-lg px-2.5 py-1.5 text-sm"
					/>
				</label>
			</div>
			{error ? (
				<p role="alert" className="mt-2 text-xs text-neg">
					{error}
				</p>
			) : null}
			<div className="mt-3 flex justify-end gap-2">
				<button
					type="button"
					onClick={onClose}
					className="rounded-lg px-3 py-1.5 text-sm font-medium text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={apply}
					className="rounded-lg btn-accent px-3 py-1.5 text-sm"
				>
					Apply
				</button>
			</div>
		</fieldset>
	);
}

export function DateRange({ dark = false }: { dark?: boolean }): ReactElement {
	const { preset, setPreset, selection } = useDashboard();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverId = useId();
	const isCustom = selection.kind === 'custom';

	// Shared dismissal: this popover only closed on an outside click, so a keyboard user who opened it
	// had no way to back out — Escape did nothing and the trigger never got focus back.
	const close = useCallback(() => setOpen(false), []);
	usePopoverDismiss(open, close, ref, triggerRef);

	const customLabel = isCustom
		? `${formatDateInput(selection.start)} → ${formatDateInput(selection.end)}`
		: 'Custom';

	return (
		<div className="flex flex-wrap items-center gap-2">
			{/* The four presets are one control with four states; without a group name they read to a
			    screen reader as four unrelated toggles called "24h", "7d", "30d", "90d". */}
			<fieldset
				aria-label="Date range preset"
				className={cn(
					'inline-flex rounded-lg border p-0.5',
					dark
						? 'border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))]'
						: 'border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))]',
				)}
			>
				{RANGE_PRESETS.map((option) => (
					<button
						key={option}
						type="button"
						aria-pressed={preset === option}
						onClick={() => setPreset(option)}
						// No focus:outline-none: it beat the shell's token outline and left only a
						// 40%-alpha ring, which measures 1.5–2.3:1 depending on the palette.
						className={cn(
							'tabular rounded-md px-3 py-1 text-sm font-semibold transition',
							preset === option
								? dark
									? 'chip-active ring-1'
									: 'bg-[var(--panel)] text-accent-700 shadow-sm ring-1 ring-[color:rgb(var(--border))]'
								: dark
									? 'text-[color:var(--muted)] hover:text-[color:var(--ink)]'
									: 'text-[color:var(--muted)] hover:text-[color:var(--ink)]',
						)}
					>
						{LABELS[option]}
					</button>
				))}
			</fieldset>

			<div className="relative" ref={ref}>
				<button
					ref={triggerRef}
					type="button"
					aria-pressed={isCustom}
					aria-expanded={open}
					aria-controls={open ? popoverId : undefined}
					onClick={() => setOpen((v) => !v)}
					className={cn(
						'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition',
						isCustom
							? 'chip-active'
							: dark
								? 'border-[color:rgb(var(--border))] text-[color:var(--faint)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]'
								: 'border-[color:rgb(var(--border))] text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]',
					)}
				>
					<CalendarRange className="h-4 w-4" aria-hidden="true" />
					<span className="max-w-[16ch] truncate">{customLabel}</span>
				</button>
				{open ? <CustomPopover id={popoverId} onClose={close} /> : null}
			</div>
		</div>
	);
}
