// Small shared building blocks for the Settings CRUD panels: a titled panel wrapper, an accessible
// mutation status line (loading/success/error, never color-only), a destructive-action confirmer that
// states the consequence, and label+control pairs. All surfaces are theme tokens (see the surface
// primitives in index.css), so Settings matches the active palette in both modes instead of rendering
// as white cards on the dark shell.

import { Loader2, Trash2 } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { cn } from '../../lib/cn.js';

export function Panel({
	title,
	description,
	action,
	children,
}: {
	title: string;
	/** Optional one-line explanation shown under the title — what this panel is for. */
	description?: string;
	/** Optional control rendered on the title row (e.g. a "Docs" link or a count). */
	action?: ReactNode;
	children: ReactNode;
}): ReactElement {
	return (
		<section className="surface rounded-xl p-5">
			<div className="mb-4 flex flex-wrap items-start justify-between gap-2">
				<div>
					<h3 className="font-semibold text-[color:var(--ink)] text-sm">{title}</h3>
					{description ? (
						<p className="mt-0.5 max-w-prose text-[color:var(--muted)] text-xs">
							{description}
						</p>
					) : null}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

/**
 * Wraps a form's controls so a single `busy` flag disables every input, select and button inside it
 * natively. A real <fieldset disabled> is used rather than threading `disabled` through each control:
 * the browser then also blocks Enter-to-submit, so an in-flight mutation can't be fired twice.
 * The fieldset itself carries the layout classes so it replaces the form as the grid/stack container.
 */
export function FormControls({
	busy,
	className,
	children,
}: {
	busy: boolean;
	className?: string;
	children: ReactNode;
}): ReactElement {
	return (
		<fieldset disabled={busy} className={cn('min-w-0', className)} aria-busy={busy}>
			{children}
		</fieldset>
	);
}

/** Accessible status line for a mutation. Announces success/error via aria-live. */
export function MutationStatus({
	isPending,
	error,
	success,
	pendingLabel = 'Working…',
}: {
	isPending: boolean;
	error: unknown;
	success?: string | null;
	/** What is in flight, e.g. "Issuing key…" — vague progress text helps nobody. */
	pendingLabel?: string;
}): ReactElement | null {
	if (isPending) {
		return (
			<p
				aria-live="polite"
				className="mt-2 flex items-center gap-1.5 text-[color:var(--muted)] text-xs"
			>
				<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
				{pendingLabel}
			</p>
		);
	}
	if (error) {
		return (
			<p
				role="alert"
				aria-live="assertive"
				className="alert-error mt-2 rounded-md px-2 py-1 font-medium text-xs"
			>
				Error: {error instanceof Error ? error.message : 'request_failed'}
			</p>
		);
	}
	if (success) {
		return (
			<p
				aria-live="polite"
				className="alert-ok mt-2 rounded-md px-2 py-1 font-medium text-xs"
			>
				{success}
			</p>
		);
	}
	return null;
}

/**
 * States, in one line, why a submit button is disabled. Every panel gated its submit on a silent
 * boolean, which left the user staring at a dead button with no idea which field was short. aria-live
 * so the reason is announced rather than only seen.
 */
export function BlockedReason({ reason }: { reason: string | null }): ReactElement | null {
	if (!reason) return null;
	return (
		<p data-chrome aria-live="polite" className="text-[color:var(--faint)] text-xs">
			{reason}
		</p>
	);
}

/**
 * Two-step destructive button. Arming reveals the consequence in words plus an explicit Cancel, so a
 * stray second click can't destroy something the user never read about — the previous version armed
 * and confirmed on two clicks of the same target with no statement of what would be lost. Arming
 * lapses after a few seconds so a forgotten armed button doesn't sit there waiting for a misclick.
 */
export function ConfirmDelete({
	onConfirm,
	label = 'Delete',
	confirmLabel = 'Confirm',
	consequence,
	busy = false,
	icon: Icon = Trash2,
}: {
	onConfirm: () => void;
	label?: string;
	confirmLabel?: string;
	/** What is irreversibly lost, e.g. "Any client using this key stops working immediately." */
	consequence?: string;
	busy?: boolean;
	/** Overrides the trash can for a two-step action that is destructive but is not a deletion —
	 * ending sessions destroys no record, and a trash icon on it names the wrong consequence. */
	icon?: typeof Trash2;
}): ReactElement {
	const [armed, setArmed] = useState(false);

	useEffect(() => {
		if (!armed) return;
		const timer = setTimeout(() => setArmed(false), 8000);
		return () => clearTimeout(timer);
	}, [armed]);

	if (armed) {
		return (
			<span className="alert-error inline-flex shrink-0 items-center gap-2 rounded-md px-2 py-1">
				<span role="alert" className="font-medium text-xs">
					{consequence ?? 'This cannot be undone.'}
				</span>
				<button
					type="button"
					onClick={() => setArmed(false)}
					className="btn-ghost rounded px-2 py-0.5 font-medium text-[color:var(--ink)] text-xs"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={() => {
						setArmed(false);
						onConfirm();
					}}
					disabled={busy}
					className="btn-ghost rounded px-2 py-0.5 font-semibold text-neg text-xs"
				>
					{confirmLabel}
				</button>
			</span>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setArmed(true)}
			disabled={busy}
			className="btn-ghost inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-[color:var(--muted)] text-xs transition"
		>
			<Icon className="h-3.5 w-3.5" aria-hidden="true" />
			{label}
		</button>
	);
}

/** Shared text input for panel forms. */
export function Field({
	id,
	label,
	value,
	onChange,
	placeholder,
	type = 'text',
	hint,
	disabled,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	type?: string;
	/** Optional helper text under the field. */
	hint?: string;
	/** Inert because another control currently owns this value. State the reason in `hint`. */
	disabled?: boolean;
}): ReactElement {
	return (
		<div className="min-w-0">
			<label htmlFor={id} className="block font-medium text-[color:var(--muted)] text-xs">
				{label}
			</label>
			<input
				id={id}
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				disabled={disabled}
				aria-describedby={hint ? `${id}-hint` : undefined}
				className="input mt-1 block w-full rounded-lg px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
			/>
			{hint ? (
				<p id={`${id}-hint`} className="mt-1 text-[color:var(--faint)] text-xs">
					{hint}
				</p>
			) : null}
		</div>
	);
}

/**
 * Shared select for panel forms. Every panel had hand-rolled the same border/focus-ring string, which
 * is how three of them drifted off the `.input` token and kept a hardcoded focus ring.
 */
export function Select({
	id,
	label,
	value,
	onChange,
	hint,
	disabled,
	children,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	hint?: string;
	disabled?: boolean;
	children: ReactNode;
}): ReactElement {
	return (
		<div className="min-w-0">
			<label htmlFor={id} className="block font-medium text-[color:var(--muted)] text-xs">
				{label}
			</label>
			<select
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
				aria-describedby={hint ? `${id}-hint` : undefined}
				className="input mt-1 block w-full rounded-lg px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
			>
				{children}
			</select>
			{hint ? (
				<p id={`${id}-hint`} className="mt-1 text-[color:var(--faint)] text-xs">
					{hint}
				</p>
			) : null}
		</div>
	);
}
