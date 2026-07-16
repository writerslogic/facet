// Credential gate: shown until both an API key and site id are stored. Persists to
// localStorage via the dashboard store.

import { type FormEvent, type ReactElement, useState } from 'react';
import { cn } from '../lib/cn.js';
import { useDashboard } from '../state.js';

export function KeyGate(): ReactElement {
	const { setCredentials } = useDashboard();
	const [key, setKey] = useState('');
	const [site, setSite] = useState('');

	const canSubmit = key.trim().length > 0 && site.trim().length > 0;

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		setCredentials(key.trim(), site.trim());
	}

	return (
		<main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
			<form
				onSubmit={onSubmit}
				className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm"
			>
				<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
					Countless
				</h1>
				<p className="mt-1 text-sm text-neutral-500">
					Enter your API key and site to view analytics.
				</p>

				<label className="mt-6 block text-sm font-medium text-neutral-700">
					API key
					<input
						type="password"
						value={key}
						onChange={(e) => setKey(e.target.value)}
						autoComplete="off"
						placeholder="cl_live_…"
						className="mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
					/>
				</label>

				<label className="mt-4 block text-sm font-medium text-neutral-700">
					Site ID
					<input
						type="text"
						value={site}
						onChange={(e) => setSite(e.target.value)}
						autoComplete="off"
						placeholder="example.com"
						className="mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
					/>
				</label>

				<button
					type="submit"
					disabled={!canSubmit}
					className={cn(
						'mt-6 w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition',
						'hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40',
					)}
				>
					View dashboard
				</button>
			</form>
		</main>
	);
}
