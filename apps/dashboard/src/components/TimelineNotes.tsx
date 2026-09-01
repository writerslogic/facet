// Timeline context for the expanded traffic tile. The tile itself stays compact; full create/delete
// controls live in a focus-trapped dialog so the chart never becomes an internally-scrolling form.

import {
	TIMELINE_ANNOTATION_CATEGORIES,
	type TimelineAnnotation,
	type TimelineAnnotationCategory,
} from '@facet/shared';
import { X } from 'lucide-react';
import { type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react';
import {
	clockLabel,
	formatDateTimeInput,
	formatStamp,
	parseDateTimeInput,
	useClockMode,
} from '../lib/datetime.js';
import { useDialogFocus } from '../lib/useDialogFocus.js';
import type { Range } from '../state.js';
import {
	BlockedReason,
	ConfirmDelete,
	Field,
	FormControls,
	MutationStatus,
	Select,
} from './settings/kit.js';

const CATEGORY_LABEL: Record<TimelineAnnotationCategory, string> = {
	note: 'Note',
	release: 'Release',
	campaign: 'Campaign',
	incident: 'Incident',
};

export interface TimelineAnnotationManager {
	notes: TimelineAnnotation[];
	range: Range;
	canManage: boolean;
	readOnlyReason: 'demo' | 'missing-admin' | null;
	isLoading: boolean;
	isSaving: boolean;
	isDeleting: boolean;
	loadError: string | null;
	mutationError: string | null;
	create: (input: {
		label: string;
		category: TimelineAnnotationCategory;
		occurred_at: number;
	}) => Promise<void>;
	remove: (id: string) => Promise<void>;
	requestAdmin: () => void;
}

function defaultInstant(range: Range): number {
	return Math.max(range.start, Math.min(Date.now(), range.end - 1));
}

function NoteList({
	manager,
	onRemove,
	compact = false,
}: {
	manager: TimelineAnnotationManager;
	onRemove?: (id: string) => void;
	compact?: boolean;
}): ReactElement {
	if (manager.isLoading) {
		return <p className="animate-pulse text-[color:var(--muted)] text-xs">Loading notes…</p>;
	}
	if (manager.loadError) {
		return (
			<p role="alert" className="truncate text-neg text-xs">
				Notes could not be loaded
			</p>
		);
	}
	if (manager.notes.length === 0) {
		return (
			<p className="py-2 text-center text-[color:var(--muted)] text-xs">
				{compact ? 'No context' : 'No operator notes in this range.'}
			</p>
		);
	}
	const notes = [...manager.notes].reverse().slice(0, compact ? 2 : undefined);
	return (
		<ul className={compact ? 'space-y-1' : 'space-y-2'}>
			{notes.map((note) => (
				<li
					key={note.id}
					className={`flex gap-2 text-xs ${compact ? 'items-center' : 'items-start rounded-lg bg-[color:rgb(var(--hover))] p-2.5'}`}
				>
					<span
						className={`${compact ? 'size-1.5 rounded-full' : 'rounded px-1.5 py-0.5 font-semibold text-[10px] uppercase'} shrink-0 bg-accent-500/15 text-accent-200`}
					>
						{compact ? null : CATEGORY_LABEL[note.category]}
					</span>
					<div className={`min-w-0 flex-1 ${compact ? 'flex items-center gap-2' : ''}`}>
						<p
							className={`${compact ? 'truncate' : 'break-words'} flex-1 text-[color:var(--ink)]`}
						>
							{note.label}
						</p>
						<time
							className={`${compact ? 'shrink-0' : 'mt-0.5 block'} text-[color:var(--faint)] text-[10px]`}
							dateTime={new Date(note.occurred_at).toISOString()}
						>
							{formatStamp(note.occurred_at)}
						</time>
					</div>
					{!compact && manager.canManage && onRemove ? (
						<ConfirmDelete
							label="Remove"
							consequence={`Remove “${note.label}” from the timeline?`}
							busy={manager.isDeleting}
							onConfirm={() => onRemove(note.id)}
						/>
					) : null}
				</li>
			))}
		</ul>
	);
}

function TimelineNotesDialog({
	manager,
	onClose,
}: {
	manager: TimelineAnnotationManager;
	onClose: () => void;
}): ReactElement {
	const clock = useClockMode();
	const panelRef = useRef<HTMLDivElement>(null);
	const headingId = useId();
	const [label, setLabel] = useState('');
	const [category, setCategory] = useState<TimelineAnnotationCategory>('note');
	const [when, setWhen] = useState(() =>
		formatDateTimeInput(defaultInstant(manager.range), clock),
	);
	const rangeStart = manager.range.start;
	const rangeEnd = manager.range.end;
	useDialogFocus(panelRef, onClose);

	useEffect(() => {
		setWhen(formatDateTimeInput(defaultInstant({ start: rangeStart, end: rangeEnd }), clock));
	}, [rangeStart, rangeEnd, clock]);

	const occurredAt = parseDateTimeInput(when, clock);
	const inRange = occurredAt >= rangeStart && occurredAt < rangeEnd;
	const canSubmit = Boolean(
		manager.canManage && label.trim() && Number.isSafeInteger(occurredAt) && inRange,
	);
	const blocked = !manager.canManage
		? manager.readOnlyReason === 'demo'
			? 'The public demo is read-only. These sample notes show how context appears.'
			: 'Enter the deployment admin token to add or remove context.'
		: !label.trim()
			? 'Describe what changed.'
			: !Number.isSafeInteger(occurredAt)
				? 'Choose a valid date and time.'
				: !inRange
					? 'The note must fall inside the selected analytics range.'
					: null;

	async function onSubmit(event: FormEvent): Promise<void> {
		event.preventDefault();
		if (!canSubmit) return;
		try {
			await manager.create({ label: label.trim(), category, occurred_at: occurredAt });
			setLabel('');
		} catch {}
	}

	async function remove(id: string): Promise<void> {
		try {
			await manager.remove(id);
		} catch {}
	}

	return (
		// biome-ignore lint/a11y/useSemanticElements: state-controlled overlay shares the app's focus-trapped dialog primitive
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby={headingId}
			className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-10 backdrop-blur-sm"
		>
			<div
				ref={panelRef}
				className="surface flex max-h-[calc(100vh-5rem)] w-full max-w-2xl flex-col rounded-2xl p-5"
			>
				<div className="mb-1 flex items-start justify-between gap-4">
					<div>
						<h2
							id={headingId}
							className="font-semibold text-[color:var(--ink)] text-lg"
						>
							Timeline context
						</h2>
						<p className="mt-0.5 text-[color:var(--muted)] text-xs">
							Mark releases, campaigns, and incidents beside the traffic they may
							explain.
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close timeline context"
						className="rounded-md p-1 text-[color:var(--muted)] transition hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>

				<div className="mt-4 min-h-0 overflow-y-auto pr-1">
					{manager.canManage ? (
						<form onSubmit={(event) => void onSubmit(event)}>
							<FormControls busy={manager.isSaving} className="space-y-2.5">
								<Field
									id="timeline-note-label"
									label="What changed"
									value={label}
									onChange={setLabel}
									maxLength={160}
									placeholder="Deployed checkout redesign"
								/>
								<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
									<Field
										id="timeline-note-when"
										label={`When (${clockLabel()})`}
										type="datetime-local"
										value={when}
										min={formatDateTimeInput(rangeStart, clock)}
										max={formatDateTimeInput(rangeEnd - 1, clock)}
										onChange={setWhen}
									/>
									<Select
										id="timeline-note-category"
										label="Type"
										value={category}
										onChange={(value) =>
											setCategory(value as TimelineAnnotationCategory)
										}
									>
										{TIMELINE_ANNOTATION_CATEGORIES.map((value) => (
											<option key={value} value={value}>
												{CATEGORY_LABEL[value]}
											</option>
										))}
									</Select>
								</div>
								<div className="flex items-start justify-between gap-2">
									<BlockedReason reason={blocked} />
									<button
										type="submit"
										disabled={!canSubmit}
										className="btn-accent shrink-0 rounded-lg px-3 py-1.5 font-medium text-xs transition"
									>
										Add note
									</button>
								</div>
							</FormControls>
						</form>
					) : manager.readOnlyReason === 'demo' ? (
						<p className="rounded-lg border border-[color:rgb(var(--border))] px-2.5 py-2 text-[color:var(--muted)] text-xs">
							{blocked}
						</p>
					) : (
						<div className="rounded-lg border border-[color:rgb(var(--border))] p-3 text-xs">
							<p className="text-[color:var(--muted)]">{blocked}</p>
							<button
								type="button"
								onClick={manager.requestAdmin}
								className="btn-ghost mt-2 rounded-lg px-3 py-1.5 font-medium text-xs"
							>
								Open admin settings
							</button>
						</div>
					)}

					<MutationStatus
						isPending={manager.isSaving || manager.isDeleting}
						error={manager.mutationError}
						pendingLabel={manager.isDeleting ? 'Removing note…' : 'Adding note…'}
					/>

					<div className="mt-4 border-[color:rgb(var(--border))] border-t pt-3">
						<NoteList manager={manager} onRemove={(id) => void remove(id)} />
					</div>
				</div>
			</div>
		</div>
	);
}

export function TimelineNotes({ manager }: { manager: TimelineAnnotationManager }): ReactElement {
	useClockMode();
	const [open, setOpen] = useState(false);
	return (
		<aside className="flex min-h-0 flex-col rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] p-2.5">
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0">
					<h3 className="font-semibold text-[color:var(--ink)] text-sm">
						Timeline context
					</h3>
					<p className="truncate text-[color:var(--muted)] text-[10px]">
						{manager.notes.length} operator{' '}
						{manager.notes.length === 1 ? 'note' : 'notes'} in range
					</p>
				</div>
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-haspopup="dialog"
					className="btn-ghost shrink-0 rounded-lg px-2.5 py-1 font-medium text-xs"
				>
					{manager.canManage ? 'Manage' : 'View'}
				</button>
			</div>
			<div className="mt-1.5 min-h-0 flex-1 overflow-hidden border-[color:rgb(var(--border))] border-t pt-1.5">
				<NoteList manager={manager} compact />
			</div>
			{open ? <TimelineNotesDialog manager={manager} onClose={() => setOpen(false)} /> : null}
		</aside>
	);
}
