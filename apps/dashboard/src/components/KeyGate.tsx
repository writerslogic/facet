// Credential gate: shown until at least one site profile exists. Validates the API key (`clk_`
// prefix) and Site ID (UUID) BEFORE creating a profile, with inline accessible field errors.
//
// It used to ask for two opaque credentials with no hint where either comes from, which is a dead
// end for a first-time self-hoster. Alongside the form it now explains exactly where to get them —
// both the in-app route (Settings, using the deployment's ADMIN_TOKEN) and the admin-API route —
// and states up front that more sites can be added later, since that was not discoverable either.

import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ExternalLink, Terminal } from 'lucide-react';
import {
	type FormEvent,
	type ReactElement,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from 'react';
import { useRequestSessionLink, useSessionMe, useVerifySessionToken } from '../hooks/session.js';
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
	const queryClient = useQueryClient();
	const me = useSessionMe();
	const requestLink = useRequestSessionLink();
	const loginToken = useRef(new URLSearchParams(window.location.search).get('token')).current;
	const verification = useVerifySessionToken(loginToken);
	const hydrated = useRef(false);
	const [email, setEmail] = useState('');
	const [key, setKey] = useState('');
	const [site, setSite] = useState('');
	const [label, setLabel] = useState('');
	const [submitted, setSubmitted] = useState(false);

	const keyError = validateApiKey(key);
	const siteError = validateSiteId(site);
	const showKeyError = submitted && keyError;
	const showSiteError = submitted && siteError;

	useEffect(() => {
		if (!loginToken) return;
		const url = new URL(window.location.href);
		url.searchParams.delete('token');
		if (url.pathname === '/login') url.pathname = '/';
		window.history.replaceState(null, '', url);
	}, [loginToken]);

	useEffect(() => {
		if (!verification.data) return;
		void queryClient.invalidateQueries({ queryKey: ['session', 'me'] });
	}, [queryClient, verification.data]);

	useEffect(() => {
		if (hydrated.current || !Array.isArray(me.data?.sites) || me.data.sites.length === 0) {
			return;
		}
		hydrated.current = true;
		for (const sessionSite of me.data.sites) {
			if (typeof sessionSite.id === 'string' && typeof sessionSite.name === 'string') {
				addProfile({ label: sessionSite.name, siteId: sessionSite.id, apiKey: '' });
			}
		}
	}, [addProfile, me.data?.sites]);

	function requestSignIn(event: FormEvent): void {
		event.preventDefault();
		const normalized = email.trim();
		if (normalized) requestLink.mutate(normalized);
	}

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

				<div className="surface order-first rounded-3xl p-6 shadow-float lg:order-none lg:sticky lg:top-10">
					<h2 className="font-semibold text-[color:var(--ink)] text-base">
						Sign in with your account
					</h2>
					<p className="mt-1 text-[color:var(--muted)] text-xs">
						Recommended: the credential stays in a secure HttpOnly cookie and is never
						available to dashboard JavaScript.
					</p>
					<form onSubmit={requestSignIn}>
						<label htmlFor="kg-email" className="mt-4 block font-medium text-sm">
							Email
						</label>
						<input
							id="kg-email"
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							autoComplete="email"
							className="input mt-1 block w-full rounded-lg px-3 py-2 text-sm"
						/>
						<button
							type="submit"
							disabled={!email.trim() || requestLink.isPending}
							className="btn-secondary mt-3 w-full rounded-xl px-4 py-2 text-sm"
						>
							{requestLink.isPending ? 'Sending…' : 'Email me a sign-in link'}
						</button>
					</form>
					{requestLink.isSuccess ? (
						<output className="mt-2 block text-pos text-xs">
							Check your email for a single-use sign-in link.
						</output>
					) : null}
					{requestLink.error ? (
						<p role="alert" className="mt-2 text-neg text-xs">
							Sign-in email unavailable. You can still use a site API key below.
						</p>
					) : null}
					{verification.isLoading ? (
						<output className="mt-2 block text-[color:var(--muted)] text-xs">
							Signing in…
						</output>
					) : null}
					{verification.error ? (
						<p role="alert" className="mt-2 text-neg text-xs">
							That sign-in link is invalid, expired, or already used.
						</p>
					) : null}
					{me.data?.user && me.data.sites?.length === 0 ? (
						<output className="mt-2 block text-[color:var(--muted)] text-xs">
							Signed in as {me.data.user.email}, but no sites are assigned to your
							teams.
						</output>
					) : null}

					<div className="my-5 flex items-center gap-3" aria-hidden="true">
						<span className="h-px flex-1 bg-[color:var(--line)]" />
						<span className="text-[color:var(--faint)] text-xs">or use a site key</span>
						<span className="h-px flex-1 bg-[color:var(--line)]" />
					</div>

					<form onSubmit={onSubmit} noValidate>
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
							Held in memory only; re-enter it after a page reload.
						</p>
					</form>
				</div>
			</div>
		</main>
	);
}
