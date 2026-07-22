// Credential gate: shown until at least one site profile exists. Validates the API key (`clk_`
// prefix) and Site ID (UUID) BEFORE creating a profile, with inline accessible field errors.

import { type FormEvent, type ReactElement, useState } from 'react';
import { cn } from '../lib/cn.js';
import { validateApiKey, validateSiteId } from '../lib/validate.js';
import { useDashboard } from '../state.js';
import { BrandMark } from './Layout.js';

export function KeyGate(): ReactElement {
	const { addProfile } = useDashboard();
	const [key, setKey] = useState('');
	const [site, setSite] = useState('');
	const [label, setLabel] = useState('');
	const [submitted, setSubmitted] = useState(false);

	const keyError = validateApiKey(key);
	const siteError = validateSiteId(site);
	const showKeyError = submitted && keyError;
	const showSiteError = submitted && siteError;

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		setSubmitted(true);
		if (keyError || siteError) return;
		addProfile({
			label: label.trim() || site.trim(),
			siteId: site.trim(),
			apiKey: key.trim(),
		});
	}

	return (
		<main className="flex min-h-screen items-center justify-center px-4">
			<form
				onSubmit={onSubmit}
				noValidate
				className="w-full max-w-sm rounded-3xl border border-neutral-200/70 bg-white/90 p-8 shadow-float ring-1 ring-neutral-900/5 backdrop-blur"
			>
				<BrandMark className="size-11" />
				<h1 className="mt-4 text-2xl font-semibold tracking-[-0.02em] text-neutral-900">
					Welcome to <span className="text-brand-gradient">Facet</span>
				</h1>
				<p className="mt-1 text-sm text-neutral-500">
					Enter your API key and site to view analytics.
				</p>

				<label htmlFor="kg-key" className="mt-6 block text-sm font-medium text-neutral-700">
					API key
				</label>
				<input
					id="kg-key"
					type="password"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					autoComplete="off"
					placeholder="clk_…"
					aria-invalid={Boolean(showKeyError)}
					aria-describedby={showKeyError ? 'kg-key-err' : undefined}
					className="mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/25"
				/>
				{showKeyError ? (
					<p id="kg-key-err" role="alert" className="mt-1 text-xs text-red-600">
						{keyError}
					</p>
				) : null}

				<label
					htmlFor="kg-site"
					className="mt-4 block text-sm font-medium text-neutral-700"
				>
					Site ID
				</label>
				<input
					id="kg-site"
					type="text"
					value={site}
					onChange={(e) => setSite(e.target.value)}
					autoComplete="off"
					placeholder="xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx"
					aria-invalid={Boolean(showSiteError)}
					aria-describedby={showSiteError ? 'kg-site-err' : undefined}
					className="mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/25"
				/>
				{showSiteError ? (
					<p id="kg-site-err" role="alert" className="mt-1 text-xs text-red-600">
						{siteError}
					</p>
				) : null}

				<label
					htmlFor="kg-label"
					className="mt-4 block text-sm font-medium text-neutral-700"
				>
					Label <span className="text-neutral-400">(optional)</span>
				</label>
				<input
					id="kg-label"
					type="text"
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					autoComplete="off"
					placeholder="Production"
					className="mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/25"
				/>

				<button
					type="submit"
					className={cn(
						'mt-6 w-full rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-semibold text-white shadow-card transition',
						'hover:shadow-float hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 disabled:cursor-not-allowed disabled:opacity-40',
					)}
				>
					View dashboard
				</button>
			</form>
		</main>
	);
}
