// Small shared building blocks for the Settings CRUD panels: a titled panel wrapper, an accessible
// mutation status line (loading/success/error, never color-only), and a two-step destructive button.

import { Loader2, Trash2 } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { cn } from '../../lib/cn.js';

export function Panel({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}): ReactElement {
	return (
		<section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
			<h3 className="mb-4 text-sm font-semibold text-neutral-700">{title}</h3>
			{children}
		</section>
	);
}

/** Accessible status line for a mutation. Announces success/error via aria-live. */
export function MutationStatus({
	isPending,
	error,
	success,
}: {
	isPending: boolean;
	error: unknown;
	success?: string | null;
}): ReactElement | null {
	if (isPending) {
		return (
			<p
				aria-live="polite"
				className="mt-2 flex items-center gap-1.5 text-xs text-neutral-500"
			>
				<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
				Working…
			</p>
		);
	}
	if (error) {
		return (
			<p
				role="alert"
				aria-live="assertive"
				className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700"
			>
				Error: {error instanceof Error ? error.message : 'request_failed'}
			</p>
		);
	}
	if (success) {
		return (
			<p
				aria-live="polite"
				className="mt-2 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700"
			>
				{success}
			</p>
		);
	}
	return null;
}

/** Two-step delete button: first click asks for confirmation, second click fires `onConfirm`. */
export function ConfirmDelete({
	onConfirm,
	label = 'Delete',
	confirmLabel = 'Confirm',
}: {
	onConfirm: () => void;
	label?: string;
	confirmLabel?: string;
}): ReactElement {
	const [armed, setArmed] = useState(false);

	return (
		<button
			type="button"
			onClick={() => {
				if (!armed) {
					setArmed(true);
					return;
				}
				setArmed(false);
				onConfirm();
			}}
			onBlur={() => setArmed(false)}
			aria-label={armed ? confirmLabel : label}
			className={cn(
				'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition',
				armed
					? 'border-red-300 bg-red-50 text-red-700'
					: 'border-neutral-200 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800',
			)}
		>
			<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
			{armed ? confirmLabel : label}
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
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	type?: string;
}): ReactElement {
	return (
		<div>
			<label htmlFor={id} className="block text-xs font-medium text-neutral-600">
				{label}
			</label>
			<input
				id={id}
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
			/>
		</div>
	);
}
