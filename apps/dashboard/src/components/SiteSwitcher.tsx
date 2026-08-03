// Site switcher for the header. Facet has always stored many site profiles, but the old UI was a
// bare <select> plus an unlabelled "+" icon in --faint on a near-black header — so it read as
// decoration and people re-typed credentials into "Edit" to move between sites instead of adding a
// second profile. This is an explicit menu: a labelled trigger naming the current site, every saved
// site listed with its own colour dot and Site ID, and "Add a site" as a first-class row.
//
// Switching is handled by the store; every read query is keyed by site, so no cross-site data leaks.

import { Check, ChevronDown, KeyRound, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
	type FormEvent,
	type ReactElement,
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react';
import { cn } from '../lib/cn.js';
import { isTypingTarget } from '../lib/shortcuts.js';
import { useDialogFocus } from '../lib/useDialogFocus.js';
import { validateApiKey, validateSiteId } from '../lib/validate.js';
import { type Profile, useDashboard } from '../state.js';

type Mode = 'idle' | 'add' | 'edit';

/** Above this many saved profiles the menu grows a filter. Below it, a search box on a list you can
 * already see in one glance is friction with no payoff. */
const SEARCH_THRESHOLD = 8;

/** The palette's categorical data hues, reused so each site gets a stable identity colour. */
const DOT_VARS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'] as const;

/**
 * A stable colour per site, derived from its id — two sites are then distinguishable at a glance in
 * the trigger, not just by reading the label. Deterministic so the colour never moves between loads.
 */
export function siteColorVar(siteId: string): string {
	let hash = 0;
	for (let i = 0; i < siteId.length; i++) hash = (hash * 31 + siteId.charCodeAt(i)) >>> 0;
	return DOT_VARS[hash % DOT_VARS.length] as string;
}

function SiteDot({ siteId }: { siteId: string }): ReactElement {
	const color = `var(${siteColorVar(siteId)})`;
	return (
		<span
			aria-hidden="true"
			className="inline-block size-2.5 shrink-0 rounded-full"
			style={{
				backgroundColor: color,
				boxShadow: `0 0 8px -1px ${color}`,
			}}
		/>
	);
}

export function SiteSwitcher(): ReactElement {
	const {
		profiles,
		activeProfile,
		activeProfileId,
		setActiveProfile,
		addProfile,
		updateProfile,
		removeProfile,
	} = useDashboard();
	const [mode, setMode] = useState<Mode>('idle');
	const [editing, setEditing] = useState<Profile | null>(null);
	const [open, setOpen] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [query, setQuery] = useState('');
	const menuId = useId();
	const searchId = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

	// Past a handful of profiles the menu stops being a list you scan and becomes one you hunt, so it
	// grows a filter. Below the threshold a search box would be pure friction on a two-site account.
	const searchable = profiles.length > SEARCH_THRESHOLD;
	const needle = query.trim().toLowerCase();
	const shown =
		searchable && needle
			? profiles.filter(
					(p) =>
						p.label.toLowerCase().includes(needle) ||
						p.siteId.toLowerCase().includes(needle),
				)
			: profiles;

	const close = useCallback((refocus = true) => {
		setOpen(false);
		setQuery('');
		if (refocus) triggerRef.current?.focus();
	}, []);

	// Click-outside and Escape both dismiss. Bound only while open so the app has no idle listeners.
	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: MouseEvent): void {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		}
		function onKeyDown(event: globalThis.KeyboardEvent): void {
			if (event.key === 'Escape') {
				event.stopPropagation();
				close();
			}
		}
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open, close]);

	// Where focus lands when the menu opens. With a search box that is the search box (you came here to
	// find something); otherwise the active site, so a keyboard user starts somewhere meaningful.
	useEffect(() => {
		if (!open) return;
		if (searchable) {
			searchRef.current?.focus();
			return;
		}
		const index = Math.max(
			0,
			profiles.findIndex((p) => p.id === activeProfileId),
		);
		itemRefs.current[index * 2]?.focus();
	}, [open, searchable, profiles, activeProfileId]);

	// Alt+1..9 jumps straight to the Nth site without opening anything — the fast path for someone who
	// flips between two sites all day. Alt is used because Cmd/Ctrl+digit is owned by the browser's tabs.
	useEffect(() => {
		function onKeyDown(event: globalThis.KeyboardEvent): void {
			if (!event.altKey || event.ctrlKey || event.metaKey) return;
			// On macOS Alt+digit types a character (⌥1 is "¡"), so in a text field this shortcut was
			// stealing keystrokes AND switching site under the reader — the same rule the rest of the
			// keyboard layer enforces, applied to the one shortcut that predates it.
			if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
			const index = Number(event.key) - 1;
			if (!Number.isInteger(index) || index < 0 || index >= profiles.length) return;
			const target = profiles[index];
			if (!target || target.id === activeProfileId) return;
			event.preventDefault();
			setActiveProfile(target.id);
		}
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [profiles, activeProfileId, setActiveProfile]);

	/**
	 * Roving focus inside the menu: Up/Down wrap, Home/End jump to the ends, Tab dismisses.
	 *
	 * The ring covers EVERY control in the menu, interleaved in visual order — site row, its Edit
	 * button, next site row, and so on, with "Add a site" last. It used to hold only the site rows and
	 * the add row, and because Tab closes the menu, "Edit <site>" was the one control in the app that a
	 * keyboard user could not reach at all: arrows skipped it and Tab dismissed the thing containing it.
	 */
	function onItemKeyDown(event: ReactKeyboardEvent, index: number): void {
		// Two controls per VISIBLE profile (select, edit) plus the trailing "Add a site" row. Derived
		// from `shown`, not from the ref array's length, so neither a removed profile nor one filtered
		// out by the search can leave a dead slot in the ring.
		const count = shown.length * 2 + 1;
		let next: number | null = null;
		if (event.key === 'ArrowDown') next = (index + 1) % count;
		else if (event.key === 'ArrowUp') next = (index - 1 + count) % count;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = count - 1;
		else if (event.key === 'Tab') {
			setOpen(false);
			return;
		}
		if (next == null) return;
		event.preventDefault();
		itemRefs.current[next]?.focus();
	}

	return (
		<div ref={rootRef} className="relative">
			<button
				ref={triggerRef}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				aria-label={`Active site: ${activeProfile?.label ?? 'none'}. Change site`}
				onClick={() => setOpen((prev) => !prev)}
				onKeyDown={(e) => {
					if (e.key === 'ArrowDown' && !open) {
						e.preventDefault();
						setOpen(true);
					}
				}}
				className={cn(
					'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition',
					open ? 'chip-active' : 'btn-ghost',
				)}
			>
				{activeProfile ? <SiteDot siteId={activeProfile.siteId} /> : null}
				<span className="flex flex-col items-start leading-none">
					<span className="font-medium text-[10px] text-[color:var(--faint)] uppercase tracking-wider">
						Site
					</span>
					<span className="mt-0.5 max-w-[16ch] truncate font-semibold text-[color:var(--ink)]">
						{activeProfile?.label ?? 'Choose a site'}
					</span>
				</span>
				<ChevronDown
					className={cn(
						'h-4 w-4 text-[color:var(--muted)] transition',
						open && 'rotate-180',
					)}
					aria-hidden="true"
				/>
			</button>

			{open ? (
				<div
					id={menuId}
					role="menu"
					aria-label="Sites"
					className="surface absolute top-full left-0 z-40 mt-2 w-80 rounded-xl p-1.5 shadow-float"
				>
					{/* role="presentation" on the two static captions and role="none" on the row
					    wrappers: a role="menu" may only own menuitem-family children, and these three
					    were making the whole menu fail aria-required-children (critical). */}
					<p
						role="presentation"
						className="px-2.5 pt-1.5 pb-1 font-medium text-[10px] text-[color:var(--faint)] uppercase tracking-wider"
					>
						{needle
							? `${shown.length} of ${profiles.length} sites`
							: profiles.length === 1
								? '1 site'
								: `${profiles.length} sites`}
					</p>
					{searchable ? (
						<div role="presentation" className="px-1 pb-1.5">
							<label htmlFor={searchId} className="sr-only">
								Filter sites by name or Site ID
							</label>
							<input
								ref={searchRef}
								id={searchId}
								type="search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={(e) => {
									// Down from the box drops into the list; Escape clears the filter
									// first and only dismisses the menu when there is nothing to clear.
									if (e.key === 'ArrowDown') {
										e.preventDefault();
										itemRefs.current[0]?.focus();
									} else if (e.key === 'Escape' && query) {
										e.stopPropagation();
										setQuery('');
									}
								}}
								placeholder="Filter sites…"
								className="input w-full rounded-lg px-2.5 py-1.5 text-sm"
							/>
						</div>
					) : null}
					{shown.length === 0 ? (
						<p
							role="presentation"
							className="px-2.5 py-3 text-center text-[color:var(--muted)] text-sm"
						>
							No site matches “{query.trim()}”.
						</p>
					) : null}
					{shown.map((profile, index) => {
						const active = profile.id === activeProfileId;
						// The ⌥N hint is the profile's position in the FULL list — the shortcut does not
						// know about the filter, so showing its position in the filtered list would
						// print a key that jumps somewhere else.
						const ordinal = profiles.indexOf(profile);
						return (
							<div
								key={profile.id}
								role="presentation"
								className="flex items-stretch gap-1"
							>
								<button
									ref={(el) => {
										itemRefs.current[index * 2] = el;
									}}
									type="button"
									role="menuitemradio"
									aria-checked={active}
									// Roving tabindex: one stop for the whole menu, arrows move inside it.
									tabIndex={active ? 0 : -1}
									onKeyDown={(e) => onItemKeyDown(e, index * 2)}
									onClick={() => {
										setActiveProfile(profile.id);
										close();
									}}
									className={cn(
										'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition',
										active
											? 'chip-active'
											: 'text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]',
									)}
								>
									<SiteDot siteId={profile.siteId} />
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium text-sm">
											{profile.label}
										</span>
										<span
											data-selectable
											className="block truncate font-mono text-[11px] text-[color:var(--faint)]"
										>
											{profile.siteId}
										</span>
									</span>
									{active ? (
										<Check className="h-4 w-4 shrink-0" aria-hidden="true" />
									) : null}
									{ordinal >= 0 && ordinal < 9 ? (
										<kbd className="shrink-0 rounded border border-[color:rgb(var(--border))] px-1 font-mono text-[10px] text-[color:var(--faint)]">
											⌥{ordinal + 1}
										</kbd>
									) : null}
								</button>
								<button
									ref={(el) => {
										itemRefs.current[index * 2 + 1] = el;
									}}
									type="button"
									role="menuitem"
									tabIndex={-1}
									onKeyDown={(e) => onItemKeyDown(e, index * 2 + 1)}
									onClick={() => {
										setEditing(profile);
										setConfirmRemove(false);
										setMode('edit');
										setOpen(false);
									}}
									aria-label={`Edit ${profile.label}`}
									className="rounded-lg px-2 text-[color:var(--muted)] transition hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
								>
									<Pencil className="h-3.5 w-3.5" aria-hidden="true" />
								</button>
							</div>
						);
					})}

					<hr className="my-1.5 h-px border-0 bg-[color:rgb(var(--border))]" />
					<button
						ref={(el) => {
							itemRefs.current[shown.length * 2] = el;
						}}
						type="button"
						role="menuitem"
						tabIndex={-1}
						onKeyDown={(e) => onItemKeyDown(e, shown.length * 2)}
						onClick={() => {
							setEditing(null);
							setConfirmRemove(false);
							setMode('add');
							setOpen(false);
						}}
						className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left font-medium text-[color:var(--chip-ink)] text-sm transition hover:bg-[color:var(--chip-bg)]"
					>
						<Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
						Add a site
					</button>
					<p
						role="presentation"
						className="px-2.5 pt-1 pb-1.5 text-[11px] text-[color:var(--faint)]"
					>
						Each site keeps its own API key. Press ⌥ plus a number to switch instantly.
					</p>
				</div>
			) : null}

			{mode !== 'idle' ? (
				<ProfileDialog
					profile={mode === 'edit' ? editing : null}
					// The dialog is opened FROM the menu, which unmounts on the same tick — so the
					// element `useDialogFocus` captured to restore to is already gone and focus was
					// landing on <body>. The trigger is the only control that survives both, and it is
					// where the reader came from.
					onClose={() => {
						setMode('idle');
						triggerRef.current?.focus();
					}}
					onSave={(input) => {
						if (mode === 'edit' && editing) updateProfile(editing.id, input);
						else addProfile(input);
						setMode('idle');
						triggerRef.current?.focus();
					}}
					onRemove={
						mode === 'edit' && editing && profiles.length > 1
							? () => {
									if (!confirmRemove) {
										setConfirmRemove(true);
										return;
									}
									removeProfile(editing.id);
									setMode('idle');
								}
							: undefined
					}
					confirmRemove={confirmRemove}
				/>
			) : null}
		</div>
	);
}

function ProfileDialog({
	profile,
	onClose,
	onSave,
	onRemove,
	confirmRemove,
}: {
	profile: Profile | null;
	onClose: () => void;
	onSave: (input: { label: string; siteId: string; apiKey: string }) => void;
	onRemove?: () => void;
	confirmRemove: boolean;
}): ReactElement {
	const [label, setLabel] = useState(profile?.label ?? '');
	const [siteId, setSiteId] = useState(profile?.siteId ?? '');
	const [apiKey, setApiKey] = useState(profile?.apiKey ?? '');
	const [submitted, setSubmitted] = useState(false);
	const panelRef = useRef<HTMLFormElement>(null);
	const headingId = useId();

	// This overlay declared aria-modal="true" while doing none of what that promises: focus never
	// entered it, Tab walked out into the page behind the scrim after six stops, and Escape did
	// nothing. Same hook as the proof drawer, so both modals now behave identically.
	useDialogFocus(panelRef, onClose);

	const keyError = validateApiKey(apiKey);
	const siteError = validateSiteId(siteId);

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		setSubmitted(true);
		if (keyError || siteError) return;
		onSave({
			label: label.trim() || siteId.trim(),
			siteId: siteId.trim(),
			apiKey: apiKey.trim(),
		});
	}

	return (
		// biome-ignore lint/a11y/useSemanticElements: a real <dialog> would need imperative showModal(); this overlay is controlled by React state
		<div
			role="dialog"
			aria-modal="true"
			// Named by its own visible heading rather than a parallel aria-label, so the accessible
			// name can never drift from what is on screen ("Add site" vs the rendered "Add a site").
			aria-labelledby={headingId}
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
		>
			<form
				ref={panelRef}
				onSubmit={onSubmit}
				noValidate
				className="surface w-full max-w-sm rounded-2xl p-6"
			>
				<div className="mb-1 flex items-center justify-between">
					<h2 id={headingId} className="font-semibold text-[color:var(--ink)] text-lg">
						{profile ? 'Edit site' : 'Add a site'}
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
					Saved in this browser only. Add one profile per site and switch from the header
					— you never need to re-enter these.
				</p>

				<label
					htmlFor="ps-label"
					className="block font-medium text-[color:var(--ink)] text-sm"
				>
					Label
				</label>
				<input
					id="ps-label"
					type="text"
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Marketing site"
					className="input mt-1 block w-full rounded-lg px-3 py-2 text-sm"
				/>

				<label
					htmlFor="ps-site"
					className="mt-3 block font-medium text-[color:var(--ink)] text-sm"
				>
					Site ID
				</label>
				<input
					id="ps-site"
					type="text"
					value={siteId}
					onChange={(e) => setSiteId(e.target.value)}
					placeholder="xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx"
					aria-invalid={Boolean(submitted && siteError)}
					aria-describedby={submitted && siteError ? 'ps-site-err' : undefined}
					className="input mt-1 block w-full rounded-lg px-3 py-2 font-mono text-sm"
				/>
				{submitted && siteError ? (
					<p id="ps-site-err" role="alert" className="mt-1 text-neg text-xs">
						{siteError}
					</p>
				) : null}

				<label
					htmlFor="ps-key"
					className="mt-3 block font-medium text-[color:var(--ink)] text-sm"
				>
					API key
				</label>
				<input
					id="ps-key"
					type="password"
					value={apiKey}
					onChange={(e) => setApiKey(e.target.value)}
					placeholder="clk_…"
					aria-invalid={Boolean(submitted && keyError)}
					aria-describedby={submitted && keyError ? 'ps-key-err' : 'ps-key-hint'}
					className="input mt-1 block w-full rounded-lg px-3 py-2 text-sm"
				/>
				{submitted && keyError ? (
					<p id="ps-key-err" role="alert" className="mt-1 text-neg text-xs">
						{keyError}
					</p>
				) : (
					<p
						id="ps-key-hint"
						className="mt-1 flex items-start gap-1.5 text-[color:var(--faint)] text-xs"
					>
						<KeyRound className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />A key is
						bound to one site. Issue one per site under Settings → API keys.
					</p>
				)}

				<div className="mt-5 flex items-center justify-between gap-2">
					{onRemove ? (
						<button
							type="button"
							onClick={onRemove}
							className={cn(
								'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-sm transition',
								confirmRemove ? 'alert-error' : 'btn-ghost',
							)}
						>
							<Trash2 className="h-4 w-4" aria-hidden="true" />
							{confirmRemove ? 'Confirm remove' : 'Remove'}
						</button>
					) : (
						<span />
					)}
					<button
						type="submit"
						className="btn-accent inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm transition"
					>
						<Check className="h-4 w-4" aria-hidden="true" />
						Save
					</button>
				</div>
			</form>
		</div>
	);
}
