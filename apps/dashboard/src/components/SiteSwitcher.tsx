// Accessible site-profile switcher for the header: a labeled select for the active profile plus
// add / rename / remove actions. The active site is always shown explicitly. Switching the active
// profile is handled by the store; queries are keyed by site so no cross-site data leaks.

import { Check, Plus, Trash2, X } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { cn } from '../lib/cn.js';
import { validateApiKey, validateSiteId } from '../lib/validate.js';
import { type Profile, useDashboard } from '../state.js';

type Mode = 'idle' | 'add' | 'edit';

export function SiteSwitcher({
	dark = false,
}: {
	dark?: boolean;
}): ReactElement {
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
	const [confirmRemove, setConfirmRemove] = useState(false);

	return (
		<div className="flex items-center gap-2">
			<label htmlFor="site-switcher" className="sr-only">
				Active site
			</label>
			<select
				id="site-switcher"
				value={activeProfileId}
				onChange={(e) => setActiveProfile(e.target.value)}
				className={cn(
					'rounded-lg border px-2 py-1.5 text-sm focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400 [&>option]:text-[color:var(--ink)]',
					dark
						? 'border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] text-[color:var(--faint)]'
						: 'border-[color:rgb(var(--border))] bg-[var(--panel)] text-[color:var(--ink)]',
				)}
			>
				{profiles.map((p) => (
					<option key={p.id} value={p.id}>
						{p.label}
					</option>
				))}
			</select>

			<button
				type="button"
				onClick={() => {
					setMode('edit');
					setConfirmRemove(false);
				}}
				disabled={!activeProfile}
				className={cn(
					'rounded-lg border px-2 py-1.5 text-xs font-medium transition disabled:opacity-40',
					dark
						? 'border-[color:rgb(var(--border))] text-[color:var(--faint)] hover:bg-[color:rgb(var(--hover))]'
						: 'border-[color:rgb(var(--border))] text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]',
				)}
			>
				Edit
			</button>
			<button
				type="button"
				onClick={() => {
					setMode('add');
					setConfirmRemove(false);
				}}
				title="Add site"
				aria-label="Add site"
				className={cn(
					'inline-flex items-center rounded-lg border px-2 py-1.5 transition',
					dark
						? 'border-[color:rgb(var(--border))] text-[color:var(--faint)] hover:bg-[color:rgb(var(--hover))]'
						: 'border-[color:rgb(var(--border))] text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]',
				)}
			>
				<Plus className="h-4 w-4" aria-hidden="true" />
			</button>

			{mode !== 'idle' ? (
				<ProfileDialog
					profile={mode === 'edit' ? activeProfile : null}
					onClose={() => setMode('idle')}
					onSave={(input) => {
						if (mode === 'edit' && activeProfile) {
							updateProfile(activeProfile.id, input);
						} else {
							addProfile(input);
						}
						setMode('idle');
					}}
					onRemove={
						mode === 'edit' && activeProfile
							? () => {
									if (!confirmRemove) {
										setConfirmRemove(true);
										return;
									}
									removeProfile(activeProfile.id);
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
			aria-label={profile ? 'Edit site' : 'Add site'}
			className="fixed inset-0 z-30 flex items-center justify-center bg-neutral-900/30 px-4"
		>
			<form
				onSubmit={onSubmit}
				noValidate
				className="w-full max-w-sm rounded-2xl border border-[color:rgb(var(--border))] bg-[var(--panel)] p-6 shadow-lg"
			>
				<div className="mb-4 flex items-center justify-between">
					<h2 className="text-lg font-semibold text-[color:var(--ink)]">
						{profile ? 'Edit site' : 'Add site'}
					</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="rounded-md p-1 text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>

				<label
					htmlFor="ps-label"
					className="block text-sm font-medium text-[color:var(--ink)]"
				>
					Label
				</label>
				<input
					id="ps-label"
					type="text"
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Production"
					className="mt-1 block w-full rounded-lg border border-[color:rgb(var(--border))] px-3 py-2 text-sm outline-none focus:border-[color:rgb(var(--border))] focus:ring-1 focus:ring-[color:rgb(var(--border))]"
				/>

				<label
					htmlFor="ps-site"
					className="mt-3 block text-sm font-medium text-[color:var(--ink)]"
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
					className="mt-1 block w-full rounded-lg border border-[color:rgb(var(--border))] px-3 py-2 text-sm outline-none focus:border-[color:rgb(var(--border))] focus:ring-1 focus:ring-[color:rgb(var(--border))]"
				/>
				{submitted && siteError ? (
					<p id="ps-site-err" role="alert" className="mt-1 text-xs text-red-600">
						{siteError}
					</p>
				) : null}

				<label
					htmlFor="ps-key"
					className="mt-3 block text-sm font-medium text-[color:var(--ink)]"
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
					aria-describedby={submitted && keyError ? 'ps-key-err' : undefined}
					className="mt-1 block w-full rounded-lg border border-[color:rgb(var(--border))] px-3 py-2 text-sm outline-none focus:border-[color:rgb(var(--border))] focus:ring-1 focus:ring-[color:rgb(var(--border))]"
				/>
				{submitted && keyError ? (
					<p id="ps-key-err" role="alert" className="mt-1 text-xs text-red-600">
						{keyError}
					</p>
				) : null}

				<div className="mt-5 flex items-center justify-between gap-2">
					{onRemove ? (
						<button
							type="button"
							onClick={onRemove}
							className={cn(
								'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition',
								confirmRemove
									? 'border-red-300 bg-red-50 text-red-700'
									: 'border-[color:rgb(var(--border))] text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]',
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
						className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700"
					>
						<Check className="h-4 w-4" aria-hidden="true" />
						Save
					</button>
				</div>
			</form>
		</div>
	);
}
