// The `?` overlay, and the visible button that opens it.
//
// The button is the point. A keyboard layer whose only door is a keystroke you have to already know
// is not discoverable, so the header carries a labelled control — and the overlay it opens is
// generated from `SHORTCUTS`, so it can never list something the app does not do, or omit something
// it does.
//
// Focus: `useDialogFocus` gives this the same contract as the site dialog and the proof drawer —
// focus moves in on open, Tab stays inside, Escape closes, and focus returns to the trigger. All of
// it is chrome, so `data-chrome` keeps it out of a Cmd+A copy of the data.

import { Keyboard, X } from 'lucide-react';
import { type ReactElement, useId, useMemo, useRef } from 'react';
import { SHORTCUTS, SHORTCUT_GROUPS, type Shortcut, type ShortcutGroup } from '../lib/shortcuts.js';
import { useDialogFocus } from '../lib/useDialogFocus.js';

/** Header control that opens the overlay — the discovery route for everything in it. */
export function ShortcutHelpButton({
	onOpen,
	open,
}: {
	onOpen: () => void;
	open: boolean;
}): ReactElement {
	return (
		<button
			type="button"
			data-chrome
			onClick={onOpen}
			aria-expanded={open}
			aria-haspopup="dialog"
			title="Keyboard shortcuts (press ?)"
			className="btn-ghost inline-flex items-center gap-1.5 rounded-lg border border-[color:rgb(var(--border))] px-2.5 py-1.5 font-medium text-sm transition"
		>
			<Keyboard className="h-4 w-4" aria-hidden="true" />
			<span className="sr-only sm:not-sr-only">Shortcuts</span>
			<kbd className="rounded border border-[color:rgb(var(--border))] px-1 font-mono text-[10px] text-[color:var(--faint)]">
				?
			</kbd>
		</button>
	);
}

function Row({ shortcut }: { shortcut: Shortcut }): ReactElement {
	return (
		<div className="flex items-baseline justify-between gap-4 py-1.5">
			<span className="text-[color:var(--muted)] text-sm">{shortcut.label}</span>
			<kbd className="surface-2 shrink-0 rounded px-2 py-0.5 font-mono text-[color:var(--ink)] text-xs">
				{shortcut.display}
			</kbd>
		</div>
	);
}

export function ShortcutHelp({ onClose }: { onClose: () => void }): ReactElement {
	const panelRef = useRef<HTMLDivElement>(null);
	const headingId = useId();
	useDialogFocus(panelRef, onClose);

	const grouped = useMemo(() => {
		const out: { group: ShortcutGroup; items: Shortcut[] }[] = [];
		for (const group of SHORTCUT_GROUPS) {
			const items = SHORTCUTS.filter((shortcut) => shortcut.group === group);
			if (items.length > 0) out.push({ group, items });
		}
		return out;
	}, []);

	return (
		// biome-ignore lint/a11y/useSemanticElements: a real <dialog> needs imperative showModal(); this overlay is React-state controlled, like the site dialog
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby={headingId}
			data-chrome
			className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-10 backdrop-blur-sm"
		>
			<div ref={panelRef} className="surface w-full max-w-lg rounded-2xl p-6">
				<div className="mb-1 flex items-start justify-between gap-4">
					<h2 id={headingId} className="font-semibold text-[color:var(--ink)] text-lg">
						Keyboard shortcuts
					</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="rounded-md p-1 text-[color:var(--muted)] transition hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
				<p className="mb-4 text-[color:var(--muted)] text-xs">
					Single keys, no modifier. They never fire while you are typing in a field, so{' '}
					<kbd className="surface-2 rounded px-1 font-mono text-[11px]">?</kbd> in the Ask
					box is a question mark, not this list.
				</p>

				{grouped.map(({ group, items }) => (
					<section key={group} className="mt-4 first:mt-0">
						<h3 className="font-semibold text-[10px] text-[color:var(--faint)] uppercase tracking-[0.08em]">
							{group}
						</h3>
						<div className="mt-1 divide-y divide-[color:rgb(var(--border))]">
							{items.map((shortcut) => (
								<Row key={shortcut.id} shortcut={shortcut} />
							))}
						</div>
					</section>
				))}

				<section className="mt-4">
					<h3 className="font-semibold text-[10px] text-[color:var(--faint)] uppercase tracking-[0.08em]">
						Elsewhere
					</h3>
					<div className="mt-1 divide-y divide-[color:rgb(var(--border))]">
						<div className="flex items-baseline justify-between gap-4 py-1.5">
							<span className="text-[color:var(--muted)] text-sm">
								Jump to your nth saved site
							</span>
							<kbd className="surface-2 shrink-0 rounded px-2 py-0.5 font-mono text-[color:var(--ink)] text-xs">
								⌥1 … ⌥9
							</kbd>
						</div>
						<div className="flex items-baseline justify-between gap-4 py-1.5">
							<span className="text-[color:var(--muted)] text-sm">
								Move along the tab strip once a tab has focus
							</span>
							<kbd className="surface-2 shrink-0 rounded px-2 py-0.5 font-mono text-[color:var(--ink)] text-xs">
								← →
							</kbd>
						</div>
						<div className="flex items-baseline justify-between gap-4 py-1.5">
							<span className="text-[color:var(--muted)] text-sm">
								Select the data on the page — figures, tables and prose, without the
								UI chrome
							</span>
							<kbd className="surface-2 shrink-0 rounded px-2 py-0.5 font-mono text-[color:var(--ink)] text-xs">
								⌘A
							</kbd>
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}
