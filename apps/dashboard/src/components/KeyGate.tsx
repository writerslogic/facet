// Credential gate: shown until at least one site profile exists. Validates the API key (`clk_`
// prefix) and Site ID (UUID) BEFORE creating a profile, with inline accessible field errors.
//
// It used to ask for two opaque credentials with no hint where either comes from, which is a dead
// end for a first-time self-hoster. Alongside the form it now explains exactly where to get them —
// both the in-app route (Settings, using the deployment's ADMIN_TOKEN) and the admin-API route —
// and states up front that more sites can be added later, since that was not discoverable either.

import { ArrowRight, ExternalLink, Terminal } from 'lucide-react';
import { type FormEvent, type ReactElement, type ReactNode, useState } from 'react';
import { cn } from '../lib/cn.js';
import { validateApiKey, validateSiteId } from '../lib/validate.js';
import { useDashboard } from '../state.js';
import { BrandMark } from './Layout.js';

const REPO_DOCS = 'https://github.com/writerslogic/facet/blob/main/docs';

function Step({
	n,
	title,
	children,
}: {
	n: number;
	title: string;
	children: ReactNode;
}): ReactElement {
	return (
		<li className="flex gap-3">
			<span
				aria-hidden="true"
				className="chip-active mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border font-semibold text-xs tabular-nums"
			>
				{n}
			</span>
			<div className="min-w-0">
				<p className="font-medium text-[color:var(--ink)] text-sm">{title}</p>
				<p className="mt-0.5 text-[color:var(--muted)] text-sm leading-relaxed">
					{children}
				</p>
			</div>
		</li>
	);
}

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
		<main className="flex min-h-screen items-center justify-center px-4 py-10">
			<div className="grid w-full max-w-4xl gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
				<section className="surface rounded-3xl p-8">
					<BrandMark className="size-11" />
					<h1 className="mt-4 font-semibold text-2xl text-[color:var(--ink)] tracking-[-0.02em]">
						Welcome to <span className="text-prism">Facet</span>
					</h1>
					<p className="mt-1 text-[color:var(--muted)] text-sm">
						Connect a site to view its analytics. You can add more sites afterwards and
						switch between them from the header — this is a one-time step per site.
					</p>

					<h2 className="mt-6 font-semibold text-[color:var(--ink)] text-sm">
						Where do these come from?
					</h2>
					<ol className="mt-3 space-y-3.5">
						<Step n={1} title="Deploy Facet and set an admin token">
							Your deployment holds one <code>ADMIN_TOKEN</code> secret, set with{' '}
							<code>wrangler secret put ADMIN_TOKEN</code>. It's the master credential
							that creates sites and issues keys.
						</Step>
						<Step n={2} title="Create a site to get the Site ID">
							Open <strong>Settings</strong> in this dashboard, paste the admin token,
							then use the <strong>Sites</strong> panel to create your site. Its UUID
							is shown beneath the name — that's the Site ID, and the same value goes
							in your tracking snippet's <code>data-site-id</code>.
						</Step>
						<Step n={3} title="Issue an API key for that site">
							Press <strong>Manage</strong> on the site, then{' '}
							<strong>Issue key</strong> in the <strong>API keys</strong> panel. The
							key starts with <code>clk_</code> and is shown{' '}
							<strong>only once</strong> — copy it straight into the form here.
						</Step>
					</ol>

					<div className="alert-info mt-5 flex items-start gap-2.5 rounded-lg p-3 text-sm">
						<Terminal className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
						<span>
							Prefer the command line? Both steps are plain admin-API calls —{' '}
							<a
								href={`${REPO_DOCS}/self-hosting.md`}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
							>
								self-hosting guide
								<ExternalLink className="h-3 w-3" aria-hidden="true" />
							</a>
							. A key is bound to one site, so issue one per site.
						</span>
					</div>
				</section>

				<form
					onSubmit={onSubmit}
					noValidate
					className="surface rounded-3xl p-6 shadow-float lg:sticky lg:top-10"
				>
					<h2 className="font-semibold text-[color:var(--ink)] text-base">
						Connect your first site
					</h2>

					<label
						htmlFor="kg-key"
						className="mt-5 block font-medium text-[color:var(--ink)] text-sm"
					>
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
						aria-describedby={showKeyError ? 'kg-key-err' : 'kg-key-hint'}
						className="input mt-1 block w-full rounded-lg px-3 py-2 text-sm"
					/>
					{showKeyError ? (
						<p id="kg-key-err" role="alert" className="mt-1 text-neg text-xs">
							{keyError}
						</p>
					) : (
						<p id="kg-key-hint" className="mt-1 text-[color:var(--faint)] text-xs">
							Settings → API keys → Issue key
						</p>
					)}

					<label
						htmlFor="kg-site"
						className="mt-4 block font-medium text-[color:var(--ink)] text-sm"
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
						aria-describedby={showSiteError ? 'kg-site-err' : 'kg-site-hint'}
						className="input mt-1 block w-full rounded-lg px-3 py-2 font-mono text-sm"
					/>
					{showSiteError ? (
						<p id="kg-site-err" role="alert" className="mt-1 text-neg text-xs">
							{siteError}
						</p>
					) : (
						<p id="kg-site-hint" className="mt-1 text-[color:var(--faint)] text-xs">
							Settings → Sites, shown under the site name
						</p>
					)}

					<label
						htmlFor="kg-label"
						className="mt-4 block font-medium text-[color:var(--ink)] text-sm"
					>
						Label <span className="text-[color:var(--muted)]">(optional)</span>
					</label>
					<input
						id="kg-label"
						type="text"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						autoComplete="off"
						placeholder="Marketing site"
						aria-describedby="kg-label-hint"
						className="input mt-1 block w-full rounded-lg px-3 py-2 text-sm"
					/>
					<p id="kg-label-hint" className="mt-1 text-[color:var(--faint)] text-xs">
						What this site is called in the switcher
					</p>

					<button
						type="submit"
						className={cn(
							'btn-accent mt-6 flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm shadow-card transition',
							'hover:shadow-float',
						)}
					>
						View dashboard
						<ArrowRight className="h-4 w-4" aria-hidden="true" />
					</button>
					<p className="mt-3 text-center text-[color:var(--faint)] text-xs">
						Stored in this browser only, never sent anywhere but your own deployment.
					</p>
				</form>
			</div>
		</main>
	);
}
