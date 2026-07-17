// Prompts for the ADMIN_TOKEN when absent. The token is stored in memory/sessionStorage only via
// the admin store; it is never written to localStorage or the profile store, and never logged.

import { ShieldAlert } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useAdmin } from '../../admin.js';

export function AdminTokenGate(): ReactElement {
	const { setToken } = useAdmin();
	const [value, setValue] = useState('');

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (value.trim()) setToken(value.trim());
	}

	return (
		<form
			onSubmit={onSubmit}
			className="mx-auto max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm"
		>
			<div className="flex items-start gap-3">
				<ShieldAlert
					className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
					aria-hidden="true"
				/>
				<div>
					<h2 className="text-lg font-semibold text-neutral-900">Admin token required</h2>
					<p className="mt-1 text-sm text-neutral-500">
						Settings manages sites, keys, goals, funnels, and experiments. Enter your
						deployment ADMIN_TOKEN to continue. It grants deployment-wide admin access
						and is stored for this browser tab only.
					</p>
				</div>
			</div>

			<label
				htmlFor="admin-token"
				className="mt-5 block text-sm font-medium text-neutral-700"
			>
				Admin token
			</label>
			<input
				id="admin-token"
				type="password"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				autoComplete="off"
				className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
			/>

			<button
				type="submit"
				disabled={!value.trim()}
				className="mt-5 w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
			>
				Enter admin
			</button>
		</form>
	);
}
