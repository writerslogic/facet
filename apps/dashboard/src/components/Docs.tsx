// In-app documentation. Everything needed to go from "empty dashboard" to "reading numbers with
// confidence" without leaving the app: install, site + key setup, what each metric actually counts
// (Facet's privacy model makes several of them subtly different from other analytics tools), a tour
// of the tabs, shortcuts, and the failure modes people actually hit.
//
// Content is authored as data (SECTIONS) rather than markdown so it stays searchable and ships with
// no renderer dependency. Every factual claim here is checked against the implementation, not
// against docs/*.md — where the two disagree the code wins, and the prose says so explicitly.

import { Check, Copy, ExternalLink, Link2, Search } from 'lucide-react';
import {
	type ReactElement,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	isValidElement,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { cn } from '../lib/cn.js';

const REPO_DOCS = 'https://github.com/writerslogic/facet/blob/main/docs';

/** Copy `text` to the clipboard, flipping a transient "copied" flag. Never throws: an insecure
 * context has no clipboard API, and the underlying content is selectable anyway. */
function useCopy(): [boolean, (text: string) => void] {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);
	const copy = useCallback((text: string) => {
		navigator.clipboard?.writeText(text).then(
			() => {
				setCopied(true);
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), 1500);
			},
			() => {
				/* clipboard blocked (insecure context) — the text is selectable anyway */
			},
		);
	}, []);
	return [copied, copy];
}

/** A copyable code block. Code is `data-selectable` so Cmd+A / drag-select still yields the snippet. */
function Code({ children, lang }: { children: string; lang?: string }): ReactElement {
	const [copied, copy] = useCopy();
	return (
		<div className="surface-2 group relative mt-2 rounded-lg">
			{lang ? (
				<span className="absolute top-2 left-3 font-mono text-[10px] text-[color:var(--faint)] uppercase tracking-wider">
					{lang}
				</span>
			) : null}
			<button
				type="button"
				onClick={() => copy(children)}
				aria-label={copied ? 'Copied' : 'Copy code'}
				className="absolute top-1.5 right-1.5 rounded-md p-1.5 text-[color:var(--muted)] opacity-0 transition hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)] focus-visible:opacity-100 group-hover:opacity-100"
			>
				{copied ? (
					<Check className="h-3.5 w-3.5 text-pos" aria-hidden="true" />
				) : (
					<Copy className="h-3.5 w-3.5" aria-hidden="true" />
				)}
			</button>
			<pre
				data-selectable
				className={cn(
					'overflow-x-auto px-3 pb-3 font-mono text-[12px] text-[color:var(--ink)] leading-relaxed',
					lang ? 'pt-7' : 'pt-3',
				)}
			>
				<code>{children}</code>
			</pre>
		</div>
	);
}

function P({ children }: { children: ReactNode }): ReactElement {
	return <p className="mt-2 text-[color:var(--muted)] text-sm leading-relaxed">{children}</p>;
}

function H({ children }: { children: ReactNode }): ReactElement {
	return (
		<h3 className="mt-5 font-semibold text-[color:var(--ink)] text-sm first:mt-0">
			{children}
		</h3>
	);
}

/** Definition row for the metric glossary — the term, then precisely what it counts. */
function Def({ term, children }: { term: string; children: ReactNode }): ReactElement {
	return (
		<div className="border-[color:rgb(var(--border))] border-b py-2.5 last:border-b-0">
			<dt className="font-semibold text-[color:var(--ink)] text-sm">{term}</dt>
			<dd className="mt-0.5 text-[color:var(--muted)] text-sm leading-relaxed">{children}</dd>
		</div>
	);
}

/** A caveat worth interrupting the reader for — a place where Facet behaves unlike other tools. */
function Note({ children }: { children: ReactNode }): ReactElement {
	return <div className="alert-info mt-3 rounded-lg p-3 text-sm leading-relaxed">{children}</div>;
}

function Keys({ combo }: { combo: string }): ReactElement {
	return (
		<span className="inline-flex gap-1">
			{combo.split('+').map((k) => (
				<kbd
					key={k}
					className="surface-2 rounded px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--ink)]"
				>
					{k}
				</kbd>
			))}
		</span>
	);
}

function DocLink({ to, children }: { to: string; children: ReactNode }): ReactElement {
	return (
		<a
			href={to}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1 font-medium text-[color:var(--chip-ink)] underline-offset-2 hover:underline"
		>
			{children}
			<ExternalLink className="h-3 w-3" aria-hidden="true" />
		</a>
	);
}

interface Section {
	id: string;
	title: string;
	/** Extra words folded into the search index so a term that isn't in the prose still finds it. */
	keywords: string;
	body: ReactElement;
}

const SECTIONS: Section[] = [
	{
		id: 'start',
		title: 'Getting started',
		keywords:
			'install script tag npm snippet tracker collect beacon setup quickstart sendbeacon',
		body: (
			<>
				<P>
					Two things: a tracking snippet on your site, and a site ID + API key here. The
					snippet sends events; the key reads them back.
				</P>
				<H>1. Add the snippet</H>
				<P>
					One line in your <code>&lt;head&gt;</code>, carrying your deployment origin and
					your site's UUID. The bundle reads <code>data-site-id</code>, infers the host
					from its own <code>src</code> (override with <code>data-host</code>), fires the
					first pageview, and sends beacons via <code>navigator.sendBeacon</code>, falling
					back to a <code>keepalive</code> fetch.
				</P>
				<Code lang="html">{`<script
  defer
  src="https://your-deployment.example.com/script.js"
  data-site-id="YOUR_SITE_ID"
></script>`}</Code>
				<H>Or install the npm client</H>
				<P>
					For SPAs and frameworks where you control when events fire. <code>track()</code>{' '}
					is a no-op until <code>init()</code>. The package does <strong>not</strong>{' '}
					auto-track: pageviews, SPA navigations and form submits are script-tag
					behaviour, so call <code>track()</code> yourself.
				</P>
				<Code lang="ts">{`npm install @writerslogic/facet

import { init, track } from '@writerslogic/facet';

init({
  host: 'https://your-deployment.example.com',
  siteId: 'YOUR_SITE_ID',
});

track();                          // pageview
track('signup', { plan: 'pro' }); // custom event with props`}</Code>
				<H>2. Connect the dashboard</H>
				<P>
					Site menu in the header → <strong>Add a site</strong>, then paste the site ID
					and an API key. See <em>Sites &amp; API keys</em> below for where those come
					from.
				</P>
				<P>
					Full guide: <DocLink to={`${REPO_DOCS}/usage.md`}>docs/usage.md</DocLink>
				</P>
			</>
		),
	},
	{
		id: 'events',
		title: 'Custom events & props',
		keywords:
			'custom events props properties track name purchase revenue currency ecommerce goal validation_failed limits interactions exposure',
		body: (
			<>
				<P>
					A pageview is <code>track()</code> with no name. Anything else is a custom
					event: <code>track('signup', &#123; plan: 'pro' &#125;)</code>. Props are
					validated server-side; one that breaks a limit is rejected with{' '}
					<code>400 validation_failed</code> — dropped, not truncated.
				</P>
				<dl className="mt-3">
					<Def term="Event name">1–128 characters.</Def>
					<Def term="Props object">At most 24 keys; each key 1–40 characters.</Def>
					<Def term="Prop values">
						A string of at most 500 characters, a finite number, a boolean, or{' '}
						<code>null</code>. Nested objects and arrays are rejected.
					</Def>
				</dl>
				<H>Revenue</H>
				<P>
					<code>purchase()</code> sends a <code>purchase</code> event carrying{' '}
					<code>revenue</code> and <code>currency</code>. The server lifts those two into
					typed columns, which is what makes revenue and revenue-by-channel reporting work
					— under any other name they stay opaque props.
				</P>
				<Code lang="ts">{`import { purchase } from '@writerslogic/facet';

purchase(49.0, 'USD', { plan: 'pro', seats: 5 });
// equivalent to: track('purchase', { plan: 'pro', seats: 5, revenue: 49, currency: 'USD' })`}</Code>
				<Note>
					Names beginning with <code>$</code> are reserved for Facet's own instrumentation
					(currently <code>$exposure</code>, once per experiment per page load). Those and{' '}
					<code>form_submit</code> are excluded from the <strong>Events</strong> metric
					and the top-events breakdown, and reported separately as{' '}
					<strong>Interactions</strong>, so an auto-tracked submit can never inflate the
					custom-event number you report on.
				</Note>
			</>
		),
	},
	{
		id: 'capture',
		title: 'What the snippet captures automatically',
		keywords:
			'utm automatic capture form_submit forms data-facet-ignore spa pushstate replacestate popstate umami migration compatibility window.umami viewport screen dpr orientation',
		body: (
			<>
				<H>UTM parameters</H>
				<P>
					Every beacon reads <code>utm_source</code>, <code>utm_medium</code> and{' '}
					<code>utm_campaign</code> off the URL and sends those present. The server
					classifies each event's traffic channel from these plus the referrer. Only these
					three: <code>utm_term</code> and <code>utm_content</code> are not captured.
				</P>
				<H>SPA navigations</H>
				<P>
					The script tag patches <code>history.pushState</code> /{' '}
					<code>replaceState</code> and listens for <code>popstate</code>, so client-side
					route changes count as pageviews. A pageview repeating the previous path within
					500 ms is collapsed: routers normalize the URL on mount and would otherwise
					double-count every landing.
				</P>
				<H>Form submissions</H>
				<P>
					Submits are auto-tracked as <code>form_submit</code>, carrying only{' '}
					<code>form_id</code>, <code>form_name</code> and <code>action</code> (any may be{' '}
					<code>null</code>). <strong>No field values are ever read.</strong> Opt a form
					out with <code>data-facet-ignore</code>:
				</P>
				<Code lang="html">{`<form data-facet-ignore>
  <!-- this form's submits are not tracked -->
</form>`}</Code>
				<H>Viewport class</H>
				<P>
					The tracker buckets the viewport <em>on-device</em>: a screen tier (phone /
					tablet / laptop / desktop / ultrawide), an orientation, and a DPR class (1x / 2x
					/ 3x). Raw resolution and device-pixel ratio never leave the browser, so nothing
					fingerprint-grade is sent; the server drops anything outside that allowlist.
				</P>
				<H>Migrating from umami</H>
				<P>
					The script tag installs <code>window.umami.track(name, props)</code> alongside{' '}
					<code>window.facet</code>; both call the same <code>track()</code>. Existing
					call sites keep working, so migration is one script-tag swap: replace umami's{' '}
					<code>src</code> and <code>data-website-id</code> with Facet's <code>src</code>{' '}
					and <code>data-site-id</code>. Historical data is not imported; Facet counts
					from the swap.
				</P>
			</>
		),
	},
	{
		id: 'keys',
		title: 'Sites & API keys',
		keywords:
			'site id api key clk_ admin token credentials where find obtain create issue uuid site_mismatch bearer',
		body: (
			<>
				<P>
					A <strong>site ID</strong> is a UUID identifying one website. An{' '}
					<strong>API key</strong> (prefix <code>clk_</code>) is a read credential{' '}
					<strong>bound to exactly one site</strong> — reusing a key against a different
					site ID returns <code>site_mismatch</code>. Every site needs its own key.
				</P>
				<H>From this dashboard (easiest)</H>
				<P>
					Open <strong>Settings</strong> and enter your deployment's{' '}
					<code>ADMIN_TOKEN</code> (this browser tab only, never persisted to disk, never
					in a URL). Then:
				</P>
				<P>
					<strong>Sites</strong> → create one, or find an existing one. The UUID under its
					name is your site ID. Press <strong>Manage</strong>, then{' '}
					<strong>API keys</strong> → <strong>Issue key</strong>. The plaintext key is
					shown <strong>once and never again</strong> (only a hash is stored) — copy it
					before leaving. A lost key can't be recovered; revoke it and issue another.
				</P>
				<H>From the admin API</H>
				<P>
					The same operations over HTTP, authenticated with{' '}
					<code>Authorization: Bearer $ADMIN_TOKEN</code> — the secret you set with{' '}
					<code>wrangler secret put ADMIN_TOKEN</code> when deploying.
				</P>
				<Code lang="sh">{`# Create a site — the response contains site.id (your Site ID)
curl -X POST https://your-deployment.example.com/api/sites \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"name":"My Site","domain":"example.com"}'

# Issue a read key for that site — "key" is shown once
curl -X POST https://your-deployment.example.com/api/keys \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"site_id":"YOUR_SITE_ID","label":"reporting"}'`}</Code>
				<P>
					Deployment guide:{' '}
					<DocLink to={`${REPO_DOCS}/self-hosting.md`}>docs/self-hosting.md</DocLink>
				</P>
			</>
		),
	},
	{
		id: 'sites',
		title: 'Working with several sites',
		keywords: 'multiple sites switch toggle profile multi-site two sites add another swap',
		body: (
			<>
				<P>
					Facet holds as many sites as you like. Enter each site's credentials{' '}
					<strong>once</strong>, then switch between them; you should never re-type a key
					to change sites.
				</P>
				<H>Add each site once</H>
				<P>
					Click the site button in the header (it shows the current site), then{' '}
					<strong>Add a site</strong>. Give it a label you'll recognise, plus its site ID
					and its own API key. Repeat per site.
				</P>
				<H>Then switch freely</H>
				<P>
					The menu lists every saved site with a colour dot and its ID; pick one and the
					dashboard re-scopes. Or skip it: <Keys combo="⌥+1" /> <Keys combo="⌥+2" /> jump
					straight to the nth site.
				</P>
				<P>
					Credentials live in this browser's local storage only, never sent anywhere but
					your own deployment. Switching clears the previous site's cached data, so one
					site's numbers can never appear under another's label. The Overview bento layout
					is remembered per site.
				</P>
			</>
		),
	},
	{
		id: 'metrics',
		title: 'What the metrics mean',
		keywords:
			'definitions glossary pageviews visitors events sessions bounce rate duration channels engagement unique interactions realtime',
		body: (
			<>
				<P>
					Facet is cookieless, so a few of these count differently than you may expect.
					The differences are deliberate, and documented rather than hidden.
				</P>
				<dl className="mt-3">
					<Def term="Pageviews">Every beacon with no event name. Exact.</Def>
					<Def term="Visitors">
						A salted hash of IP + user agent + site, the salt rotating on a schedule
						(daily by default). No cookie, no persistent ID. Because it rotates, the
						same person on two days counts twice — read this as "distinct visits within
						the salt window". Under a dimension slice it is an <em>upper bound</em>.
					</Def>
					<Def term="Events">
						Named custom events only. <code>form_submit</code> and every <code>$</code>
						-prefixed internal event are <strong>excluded</strong> and counted
						separately as Interactions. Exact.
					</Def>
					<Def term="Interactions">
						The complement of Events: auto-tracked <code>form_submit</code> plus Facet's
						own <code>$exposure</code> experiment events.
					</Def>
					<Def term="Sessions">
						Derived server-side by folding a visitor's events, splitting on any
						inactivity gap over 30 minutes, then materialized by an hourly cron.
						Session-derived numbers (engagement, channels, funnels, experiments) may lag
						until the next run; the UI says so when they do.
					</Def>
					<Def term="Bounce rate">
						Share of sessions with <strong>one pageview or fewer</strong>. A session
						made only of custom events, with no pageview at all, counts as a bounce.
					</Def>
					<Def term="Pages / session, Avg duration">
						Averages across materialized sessions in the range. Duration is the span
						from a session's first to last event, so single-event sessions contribute
						zero.
					</Def>
					<Def term="Channels">
						Each event is classified from its referrer and UTM parameters into paid,
						email, social, organic, direct, internal or referral. The breakdown counts{' '}
						<em>sessions</em>, not events, and omits <code>internal</code>, so its total
						is externally-acquired sessions, not all sessions.
					</Def>
					<Def term="Active visitors (Realtime)">
						Distinct visitor hashes in the trailing 5-minute window, deduped within that
						window. A privacy-safe proxy for "who's online" — not a precise count.
					</Def>
				</dl>
			</>
		),
	},
	{
		id: 'tabs',
		title: 'A tour of the tabs',
		keywords:
			'overview realtime funnels retention experiments anomalies ask tabs navigation bento',
		body: (
			<>
				<dl className="mt-1">
					<Def term="Overview">
						The bento board: traffic over time, KPIs, and breakdowns by page, referrer,
						country, region, device, browser, OS, language, screen and network — every
						list carrying its movement against the equal-length preceding period.
						Clicking a row cross-filters the board instantly, and the selected segment
						follows you to the other tabs — each one either applies it or says plainly
						that it cannot. Drag tiles to rearrange; layout is remembered per site.
						Expand Traffic over time to place persistent release, campaign, incident, or
						general notes directly on the timeline; detected anomalies remain visually
						distinct from operator-authored context.
					</Def>
					<Def term="Explore">
						One dimension at a time, ranked — including the columns no tile on the
						Overview reaches: city, timezone, network, language, form factor, the three
						UTM parameters and currency. Groups under three distinct visitors are
						omitted, and the badge names which store answered: D1 scans every row and is
						exact, while Analytics Engine samples under load, which makes every count an
						estimate and visitors a lower bound.
					</Def>
					<Def term="Realtime">
						Who is on the site in the last five minutes, refreshing every 15 seconds and
						pausing while the browser tab is hidden.
					</Def>
					<Def term="Funnels">
						Goal conversions and multi-step funnels with the drop-off between each step.
						Define both under Settings → Goals / Funnels.
					</Def>
					<Def term="Retention">
						The cohort triangle: visitors grouped by the period of first activity (day
						or week), then the share returning later. Depth is bounded by your salt
						window; at the default daily rotation cross-day retention is legitimately
						near zero, not a bug.
					</Def>
					<Def term="Experiments">
						A/B tests with per-variant conversion against a goal you pick. Create them
						under Settings → Experiments.
					</Def>
					<Def term="Anomalies">
						Automatically flagged unusual movements in the series, with the segment
						responsible. "Investigate" pivots the Overview onto that segment. Settings →
						Alerts adds signed webhook/email destinations and inclusive thresholds over
						exact pageviews, visitors or custom events in the last completed UTC hour.
					</Def>
					<Def term="Ask">
						Natural-language questions over this site and range. The question becomes a
						constrained intent (a metric, an optional dimension, a limit) run through
						the same aggregate helpers as every other read. Model output never becomes
						SQL, and the model only ever sees aggregates.
					</Def>
				</dl>
			</>
		),
	},
	{
		id: 'experiments',
		title: 'Experiments vs feature flags',
		keywords:
			'experiments feature flags ab testing variant assignment bucketing targeting rules rollout exposure flagbool whenready',
		body: (
			<>
				<P>
					These are two separate systems that are easy to confuse. Both live under
					Settings, both hand you a variant string, and they differ in where the decision
					is made.
				</P>
				<H>Experiments — bucketed in the browser</H>
				<P>
					An experiment is a <code>flag_key</code> plus 2–8 weighted variants. The client
					fetches the active definitions once, then buckets locally by hashing a random id
					kept in <code>localStorage['facet.exp']</code>. That id is{' '}
					<strong>never sent to the server as identity</strong>; the only thing the server
					sees is an aggregate <code>$exposure</code> event carrying{' '}
					<code>&#123; flag, variant &#125;</code>, fired at most once per flag per page
					load.
				</P>
				<Code lang="ts">{`import { whenReady, assignment } from '@writerslogic/facet';

await whenReady();              // settles on success OR failure; never rejects
const a = assignment('cta');    // { variant, participating, status }
if (a.participating) render(a.variant);`}</Code>
				<P>
					<code>variant()</code> is the simpler form and always returns a string, but
					before the fetch settles — or when the visitor is opted out — it returns the
					control fallback <em>without</em> firing an exposure. Rendering on that directly
					flashes control. Gate on <code>whenReady()</code>, or use{' '}
					<code>assignment()</code>, whose <code>participating</code> is true only for a
					genuine bucketing.
				</P>
				<H>Feature flags — evaluated on the server</H>
				<P>
					Flags add <strong>targeting rules</strong> (country, device, path, custom
					attributes, sticky percentage rollout). The ruleset is deliberately not shipped
					to the browser, so evaluation happens in one <code>POST /api/flags/eval</code>{' '}
					and the result is cached for the page. Country and device are resolved
					authoritatively from the request — a browser can't know geo and could spoof it.
				</P>
				<Code lang="ts">{`import { whenFlagsReady, flagBool, flagAssignment } from '@writerslogic/facet';

await whenFlagsReady();                 // one POST /api/flags/eval
if (flagBool('new-checkout')) show();   // true only when the variant is exactly 'on'
flagAssignment('new-checkout').reason;  // pending | opted-out | unknown | disabled | rollout | rule:<n> | gpc`}</Code>
				<Note>
					Flags fail <strong>closed</strong>: while pending, when the flag is unknown, and
					whenever the visitor is opted out, the variant reads as <code>''</code> and{' '}
					<code>flagBool</code> is <code>false</code>. A feature behind a flag defaults
					off, never on.
				</Note>
			</>
		),
	},
	{
		id: 'privacy',
		title: 'Privacy, opt-out & consent',
		keywords:
			'privacy gdpr cookies consent pii ip hashing salt retention anonymous tier gpc dnt do not track optout data-facet-optout localstorage cmp identified pseudonymous',
		body: (
			<>
				<P>
					No cookies and no persistent identifiers. Visitors are counted with a salted
					hash that rotates on a schedule, so the raw IP is never stored and the hash
					cannot be linked back to a person or followed across the rotation boundary. The
					only client-side storage is the opt-out switch and, when experiments are used,
					the local bucketing id — neither is sent as identity.
				</P>
				<H>Opt-out</H>
				<P>
					Two controls, highest precedence first:{' '}
					<code>localStorage['facet.optout']</code> (<code>'1'</code>/<code>'true'</code>{' '}
					out, <code>'0'</code>/<code>'false'</code> an explicit opt-in), then{' '}
					<code>data-facet-optout</code> on the script tag (a false-like value —{' '}
					<code>false</code>, <code>0</code>, <code>no</code>, <code>off</code> — leaves
					tracking on). Either one is a <em>deliberate</em> opt-out: no trackers are
					installed at all, so no pageview, no SPA navigation, no <code>form_submit</code>
					, no experiment fetch and no exposure.
				</P>
				<Code lang="ts">{`import { optOut, optIn, isOptedOut } from '@writerslogic/facet';
// or window.facet.optOut() / optIn() / isOptedOut() with the script tag.

optOut(); // effective immediately; all collection stops`}</Code>
				<H>Do Not Track &amp; Global Privacy Control</H>
				<P>
					A passive DNT or GPC signal is treated differently from a deliberate opt-out. It{' '}
					<strong>does not</strong> suppress the anonymous, cookieless pageview — that
					carries no personal data, and counting it keeps total-traffic figures honest
					(the Plausible/Fathom position). It <strong>does</strong> suppress everything
					individual: experiments and flags are never evaluated, and server-side the
					visitor is pinned to the anonymous Tier-0 hash and can never be
					identity-elevated, whatever consent record exists. An explicit{' '}
					<code>optIn()</code> overrides the browser signal for that visitor.
				</P>
				<Note>
					The signed evidence at <code>/api/attestation/evidence</code> states this and no
					more: its privacy transforms read <code>dnt-gpc-disable-personalization</code>{' '}
					and <code>gpc-forces-anonymous-identity</code>, never an unqualified “DNT
					honored” — a claim an auditor can check against the source.
				</Note>
				<H>Identity tiers</H>
				<P>
					Settings → Identity picks how wide the linkage window is.{' '}
					<strong>Anonymous</strong> is the default and needs no configuration: the
					pre-image is <code>ip | ua | salt | siteId</code> on a daily window.{' '}
					<strong>Pseudonymous</strong> keeps that pre-image but widens the window to
					day/week/month. <strong>Identified</strong> switches to{' '}
					<code>uid:&lt;uid&gt; | salt | siteId</code> so you can join to your own CRM.
				</P>
				<P>
					Both elevated tiers require a deployment signing key, and each visitor needs a{' '}
					<em>signed consent record</em> — your backend collects real consent through your
					own CMP and calls <code>POST /api/consent</code>; the deployment signs a
					PII-free statement over the derived hash, tier and window (never IP, user agent
					or raw uid). At ingest, an event without a verifying consent record silently
					downgrades to the anonymous hash rather than being dropped. There is
					deliberately no "never" window — linkage is always bounded by retention.
				</P>
				<P>
					Details: <DocLink to={`${REPO_DOCS}/privacy.md`}>docs/privacy.md</DocLink> ·{' '}
					<DocLink to={`${REPO_DOCS}/trust.md`}>docs/trust.md</DocLink>
				</P>
			</>
		),
	},
	{
		id: 'export',
		title: 'Exporting data',
		keywords:
			'export csv json download signed jws signature rfc 9421 breakdown series dimension limit spreadsheet',
		body: (
			<>
				<P>
					The <strong>Export CSV</strong> control on the Overview downloads the current
					site, range and hostname filter — either the time series, or a breakdown by top
					pages, referrers, countries or devices.
				</P>
				<H>Over the API</H>
				<P>
					<code>GET /api/stats/export</code> takes the same shape and adds{' '}
					<code>format=json</code>. <code>kind</code> is <code>series</code> or{' '}
					<code>breakdown</code>; a breakdown needs a <code>dimension</code> of{' '}
					<code>path</code>, <code>referrer</code>, <code>country</code>,{' '}
					<code>device</code>, <code>event</code> or <code>channel</code>, with an
					optional <code>limit</code> from 1 to 1000 (default 100). CSV cells are
					formula-injection-safe, so a value starting with <code>=</code> can't execute in
					a spreadsheet.
				</P>
				<Code lang="sh">{`curl "$HOST/api/stats/export?site_id=$SITE_ID&start=$START&end=$END\\
&kind=breakdown&dimension=path&limit=50&format=csv" \\
  -H "Authorization: Bearer $FACET_API_KEY"`}</Code>
				<H>Signed exports</H>
				<P>
					When the deployment has a signing key configured, every export response also
					carries integrity headers over the exact bytes returned: an RFC 9421{' '}
					<code>Signature</code> / <code>Signature-Input</code> /{' '}
					<code>Content-Digest</code> triple, a detached JWS in{' '}
					<code>Facet-Signature-Jws</code>, and a <code>Facet-Signing-Key</code> pointer
					to the deployment's JWKS.
				</P>
				<P>
					Adding <code>&amp;sign=1</code> instead returns a self-contained signed
					envelope: a JSON document with the payload, a detached JWS over its canonical
					form, and the public JWK embedded, so it verifies offline with no network
					access. Without a configured key that request is a{' '}
					<code>501 signing_unavailable</code> rather than an unsigned fallback.
				</P>
			</>
		),
	},
	{
		id: 'trust',
		title: 'Verifiable analytics',
		keywords:
			'transparency log merkle mmr checkpoint inclusion proof consistency attestation did jwks verifiable credential vc scitt provenance verify signed receipt tamper evident',
		body: (
			<>
				<P>
					A deployment publishes signed, machine-readable statements so a third party — an
					auditor, an advertiser, a regulator — can check what it is and does without
					taking the operator's word for it. None of these ever name a visitor: they are
					claims about the <em>deployment</em> and about <em>aggregates</em>.
				</P>
				<Note>
					All of this is <strong>off until you configure a signing key</strong> (
					<code>wrangler secret put FACET_SIGNING_JWK</code>). Without one, the endpoints
					below return <code>501</code> or an empty key set, the "Verified" badges don't
					appear, and every analytics feature works exactly as before.
				</Note>
				<H>Identity of the deployment</H>
				<dl className="mt-1">
					<Def term="/.well-known/jwks.json">
						The public signing key(s). Every signature below verifies against these.
					</Def>
					<Def term="/.well-known/did.json">
						A <code>did:web:&lt;host&gt;</code> document whose verification method is
						that key. Requires Ed25519.
					</Def>
					<Def term="/.well-known/did-configuration.json">
						A domain-linkage credential proving the same key controls the origin.
					</Def>
					<Def term="/.well-known/facet-privacy.json">
						An unsigned, always-available privacy manifest in W3C DPV terms — what is
						processed, for what purpose, on what legal basis.
					</Def>
				</dl>
				<H>Signed attestations</H>
				<dl className="mt-1">
					<Def term="/api/attestation/privacy">
						A W3C VC 2.0 <code>PrivacyAttestationCredential</code> (eddsa-jcs-2022) over
						those DPV claims — the signed form of the manifest above.
					</Def>
					<Def term="/api/attestation/evidence">
						A RATS process-evidence EAT carrying the build id, git commit, schema hash,
						config hash and the enabled privacy transforms. Pass{' '}
						<code>?nonce=&lt;random&gt;</code> and it is echoed back, so you can prove
						freshness rather than replay an old one.
					</Def>
					<Def term="/api/stats/report">
						A signed <code>AnalyticsReportCredential</code> over a
						pageviews/visitors/events snapshot for one site and range. The credential
						subject is the <strong>dataset</strong>, not a person — a shareable,
						tamper-evident traffic claim.
					</Def>
				</dl>
				<H>The transparency log</H>
				<P>
					Rollups are committed to an append-only Merkle Mountain Range persisted
					alongside your data. <code>/api/transparency/checkpoint</code> is the signed
					tree head; <code>/api/transparency/inclusion</code> proves one rollup bucket is
					in that tree (API-key scoped, since a rollup belongs to a site); and{' '}
					<code>/api/transparency/consistency</code> proves the log between two sizes was
					only ever appended to — which is what makes silent back-dated edits detectable.
				</P>
				<P>
					In the dashboard this is the <strong>Verified</strong> badge on a metric.
					Clicking it opens a drawer with the real proof material — root, tree size,
					algorithm and key id, the public JWK, the detached JWS, and the inclusion path.
					The badge means "this data is committed to a signed log", not "this exact number
					has its own proof".
				</P>
				<H>Verifying offline</H>
				<P>
					The CLI runs the same verifiers in Node, so a recipient can check an export or
					credential without trusting your server at the moment they read it:
				</P>
				<Code lang="sh">{`npm i -g @writerslogic/facet-cli
facet verify ./signed-export.json`}</Code>
				<P>
					Full guide, including hardware-rooted keys and what Facet deliberately does{' '}
					<em>not</em> claim to attest:{' '}
					<DocLink to={`${REPO_DOCS}/trust.md`}>docs/trust.md</DocLink> ·{' '}
					<DocLink to={`${REPO_DOCS}/standards.md`}>docs/standards.md</DocLink>
				</P>
			</>
		),
	},
	{
		id: 'shortcuts',
		title: 'Keyboard shortcuts',
		keywords: 'keyboard shortcuts hotkeys keys accessibility select copy',
		body: (
			<>
				<dl className="mt-1">
					<Def term="Switch site">
						<Keys combo="⌥+1" /> … <Keys combo="⌥+9" /> jumps to the nth saved site
						(only up to the number of sites you've added).
					</Def>
					<Def term="Open the site menu">
						Focus the site button and press <Keys combo="↓" />. Then <Keys combo="↑" />/
						<Keys combo="↓" /> to move, <Keys combo="Home" />/<Keys combo="End" /> to
						jump to the ends, <Keys combo="Enter" /> to pick, <Keys combo="Esc" /> to
						dismiss.
					</Def>
					<Def term="Navigate these docs">
						From the search box, <Keys combo="↓" /> moves into the section list;{' '}
						<Keys combo="↑" />/<Keys combo="↓" /> walk it and <Keys combo="Enter" />{' '}
						jumps. Each section has a link button that copies a URL pointing straight at
						it.
					</Def>
					<Def term="Copy data">
						<Keys combo="⌘+A" /> selects the data on the page — figures, tables, IDs and
						prose. Buttons, tabs, labels and chart axis text are deliberately excluded
						so a copy-paste lands as usable content rather than a wall of UI strings.
					</Def>
				</dl>
			</>
		),
	},
	{
		id: 'api',
		title: 'API reference',
		keywords:
			'api endpoints rest stats collect export csv curl authentication bearer server-side ingest range 90 days',
		body: (
			<>
				<P>
					Two credential types. <strong>API keys</strong> (<code>clk_</code>, sent as{' '}
					<code>Authorization: Bearer</code>) read stats for their one site. The{' '}
					<strong>admin token</strong> manages sites, keys, goals, funnels, experiments
					and flags across the deployment.
				</P>
				<Code lang="sh">{`curl "https://your-deployment.example.com/api/stats?site_id=$SITE_ID&start=$START&end=$END&interval=day" \\
  -H "Authorization: Bearer $FACET_API_KEY"`}</Code>
				<P>
					<code>start</code> and <code>end</code> are unix milliseconds and the range may
					not exceed 90 days (<code>range_too_large</code>). <code>interval</code> is{' '}
					<code>hour</code> or <code>day</code>, defaulting to <code>hour</code> for
					ranges of 48 hours or less. Beyond <code>/api/stats</code> there are endpoints
					for the dimensional cube, sessions &amp; engagement, channels, interactions,
					retention, realtime, anomalies, export, goals, conversions, funnels,
					experiments, flags, consent, attestations and the transparency log.
				</P>
				<H>Server-side ingest</H>
				<P>
					<code>POST /api/event</code> is a first-party, API-key-authenticated ingest for
					your own backend — the same beacon shape minus <code>site_id</code> (taken from
					the key), plus optional <code>ip</code> and <code>user_agent</code> so the visit
					is attributed correctly. No client-side JavaScript is involved, so ad blockers
					and content filters can't drop it. The privacy model is identical: the IP is
					used only to derive the hash and is never stored.
				</P>
				<P>
					Every endpoint, parameter and response shape:{' '}
					<DocLink to={`${REPO_DOCS}/api.md`}>docs/api.md</DocLink>
				</P>
			</>
		),
	},
	{
		id: 'trouble',
		title: 'Troubleshooting',
		keywords:
			'troubleshooting problems no data not working error invalid_api_key site_mismatch validation_failed empty zero blocked adblock 429 rate limit',
		body: (
			<>
				<dl className="mt-1">
					<Def term="“API key not recognized”">
						The key is unknown, revoked, or paired with the wrong site. A key only works
						against the one site it was issued for — check that this profile's key and
						site ID belong together, then fix it via the pencil icon in the site menu.
					</Def>
					<Def term="No data at all">
						Confirm the snippet is on the page and the request to{' '}
						<code>/api/collect</code> returns <code>202</code> in your browser's network
						tab. A mismatched <code>data-site-id</code>, a content-security policy
						blocking the script, or an ad blocker are the usual causes. Self-hosting on
						your own domain avoids most blockers; <code>POST /api/event</code> from your
						backend avoids all of them.
					</Def>
					<Def term="Custom events never arrive">
						A payload breaking the props limits is rejected outright with{' '}
						<code>400 validation_failed</code> — check for more than 24 keys, a key over
						40 characters, a string value over 500, or a nested object. Also confirm{' '}
						<code>init()</code> ran: before it, <code>track()</code> silently does
						nothing.
					</Def>
					<Def term="Events count looks low">
						<code>form_submit</code> and <code>$</code>-prefixed events are excluded
						from Events by design. Look under Interactions for those.
					</Def>
					<Def term="Numbers exist but engagement, channels or funnels are empty">
						Those are session-derived and materialize on an hourly cron. Wait for the
						next run — the UI shows a notice while this is pending.
					</Def>
					<Def term="Retention is ~0 after day 0">
						Expected at the default daily salt rotation: visitor hashes don't survive
						the boundary, so cross-day retention cannot be observed. Widen the salt
						window under Settings → Identity if your privacy posture allows it.
					</Def>
					<Def term="Visitors looks too high when filtering">
						Under a slice, visitors is an upper bound (hashes are counted per cell and
						can't be de-duplicated across them). Pageviews and events stay exact — the
						UI flags this whenever it applies.
					</Def>
					<Def term="The date range won't go back further">
						The server caps any single query at 90 days. Raw events are also purged past
						a rolling retention window (90 days by default), though aggregated rollups
						are kept indefinitely, so long-range trends survive.
					</Def>
					<Def term="Verified badges and signed exports are missing">
						The deployment has no signing key. Set <code>FACET_SIGNING_JWK</code> — see{' '}
						<em>Verifiable analytics</em> above.
					</Def>
				</dl>
			</>
		),
	},
];

/** Flatten a section's rendered prose into plain text so search can match BODY content, not just
 * titles and keywords. `term`/`combo` are pulled in explicitly because <Def>/<Keys> carry real
 * words in props rather than children. */
function textOf(node: ReactNode): string {
	if (node === null || node === undefined || typeof node === 'boolean') return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(' ');
	if (isValidElement(node)) {
		const props = node.props as {
			children?: ReactNode;
			term?: string;
			combo?: string;
		};
		return `${props.term ?? ''} ${props.combo ?? ''} ${textOf(props.children)}`;
	}
	return '';
}

// The full-text index is built on first search, not at module load: opening the tab and never
// searching should not pay for flattening every section's tree.
let INDEX: Map<string, string> | null = null;
function searchIndex(): Map<string, string> {
	if (!INDEX) {
		INDEX = new Map(
			SECTIONS.map((s) => [
				s.id,
				`${s.id} ${s.title} ${s.keywords} ${textOf(s.body)}`
					.toLowerCase()
					.replace(/\s+/g, ' '),
			]),
		);
	}
	return INDEX;
}

/** Section ids whose title or keywords share a prefix with any query term — the "did you mean" set
 * shown when a full match fails. Deliberately looser than the search itself. */
function nearMisses(query: string): Section[] {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length >= 3);
	if (terms.length === 0) return [];
	return SECTIONS.filter((s) => {
		const label = `${s.title} ${s.keywords}`.toLowerCase();
		return terms.some((t) => {
			for (let n = Math.min(t.length, 6); n >= 3; n--) {
				if (label.includes(t.slice(0, n))) return true;
			}
			return false;
		});
	}).slice(0, 4);
}

const HASH_PREFIX = '#doc-';

/** The section id named by the current URL hash, when it is one we know about. */
function hashSectionId(): string | null {
	if (typeof window === 'undefined') return null;
	const raw = window.location.hash;
	if (!raw.startsWith(HASH_PREFIX)) return null;
	const id = raw.slice(HASH_PREFIX.length);
	return SECTIONS.some((s) => s.id === id) ? id : null;
}

export function Docs(): ReactElement {
	const [query, setQuery] = useState('');
	const [activeId, setActiveId] = useState<string>(
		() => hashSectionId() ?? SECTIONS[0]?.id ?? '',
	);
	const linkRefs = useRef<Map<string, HTMLAnchorElement>>(new Map());
	// Suppress scroll-spy briefly after a deliberate jump, so the smooth scroll passing over other
	// sections doesn't drag the highlight along with it.
	const jumpingUntil = useRef(0);

	// Search matches the section id, title, keywords AND the rendered body text, so a phrase the
	// reader remembers from the prose ("data-facet-ignore", "salt window") finds its section even
	// though it was never listed as a keyword. Every term must match; an empty query shows all.
	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return SECTIONS;
		const index = searchIndex();
		const terms = q.split(/\s+/);
		return SECTIONS.filter((s) => {
			const haystack = index.get(s.id) ?? '';
			return terms.every((t) => haystack.includes(t));
		});
	}, [query]);

	const suggestions = useMemo(
		() => (matches.length === 0 ? nearMisses(query.trim()) : []),
		[matches.length, query],
	);

	const jumpTo = useCallback((id: string) => {
		jumpingUntil.current = Date.now() + 700;
		setActiveId(id);
		// Own the hash so a reload or a shared link reopens on the same section.
		if (typeof window !== 'undefined') {
			window.history.replaceState(null, '', `${HASH_PREFIX}${id}`);
		}
		document
			.getElementById(`doc-${id}`)
			?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}, []);

	// Deep link: land on the section named by the hash. Runs once — later hash writes come from us.
	useEffect(() => {
		const id = hashSectionId();
		if (!id) return;
		document.getElementById(`doc-${id}`)?.scrollIntoView({ block: 'start' });
	}, []);

	// Scroll-spy: the sidebar tracks whichever section is highest in the viewport. Guarded because
	// jsdom (tests) and older browsers have no IntersectionObserver; the sidebar simply stops
	// auto-tracking there, which degrades cleanly.
	useEffect(() => {
		if (typeof IntersectionObserver === 'undefined') return;
		const visible = new Set<string>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = entry.target.id.replace(/^doc-/, '');
					if (entry.isIntersecting) visible.add(id);
					else visible.delete(id);
				}
				if (Date.now() < jumpingUntil.current) return;
				const top = SECTIONS.find((s) => visible.has(s.id));
				if (top) setActiveId(top.id);
			},
			// Bias the band to the top of the viewport so "current section" means the one being read,
			// not whichever happens to be tallest.
			{ rootMargin: '-80px 0px -60% 0px' },
		);
		for (const section of matches) {
			const el = document.getElementById(`doc-${section.id}`);
			if (el) observer.observe(el);
		}
		return () => observer.disconnect();
	}, [matches]);

	/** Roving keyboard navigation over the visible section links. */
	function onListKeyDown(event: ReactKeyboardEvent, index: number): void {
		const ids = matches.map((s) => s.id);
		let next: number | null = null;
		if (event.key === 'ArrowDown') next = (index + 1) % ids.length;
		else if (event.key === 'ArrowUp') next = (index - 1 + ids.length) % ids.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = ids.length - 1;
		if (next === null) return;
		event.preventDefault();
		const id = ids[next];
		if (id) linkRefs.current.get(id)?.focus();
	}

	return (
		<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
			<nav
				aria-label="Documentation sections"
				className="surface shrink-0 rounded-xl p-3 lg:sticky lg:top-20 lg:w-64"
			>
				<label htmlFor="docs-search" className="sr-only">
					Search documentation
				</label>
				<div className="relative">
					<Search
						className="-translate-y-1/2 absolute top-1/2 left-2.5 h-3.5 w-3.5 text-[color:var(--faint)]"
						aria-hidden="true"
					/>
					<input
						id="docs-search"
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							// Down arrow reaches into the results; Enter goes straight to the best one.
							const first = matches[0];
							if (!first) return;
							if (e.key === 'ArrowDown') {
								e.preventDefault();
								linkRefs.current.get(first.id)?.focus();
							} else if (e.key === 'Enter') {
								e.preventDefault();
								jumpTo(first.id);
							}
						}}
						placeholder="Search docs…"
						className="input w-full rounded-lg py-1.5 pr-2 pl-8 text-sm"
					/>
				</div>
				<ul className="mt-2 space-y-0.5">
					{matches.map((section, index) => (
						<li key={section.id}>
							<a
								ref={(el) => {
									if (el) linkRefs.current.set(section.id, el);
									else linkRefs.current.delete(section.id);
								}}
								href={`${HASH_PREFIX}${section.id}`}
								aria-current={activeId === section.id ? 'true' : undefined}
								onClick={(e) => {
									e.preventDefault();
									jumpTo(section.id);
								}}
								onKeyDown={(e) => onListKeyDown(e, index)}
								className={cn(
									'block rounded-lg px-2.5 py-1.5 text-sm transition',
									activeId === section.id
										? 'chip-active'
										: 'text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]',
								)}
							>
								{section.title}
							</a>
						</li>
					))}
				</ul>
			</nav>

			<div className="min-w-0 flex-1 space-y-4">
				{matches.map((section) => (
					<DocSection key={section.id} section={section} />
				))}
				{matches.length === 0 ? (
					<div className="surface rounded-xl p-10 text-center">
						<p className="font-semibold text-[color:var(--ink)] text-sm">
							No documentation matches “{query}”
						</p>
						{suggestions.length > 0 ? (
							<>
								<p className="mt-1 text-[color:var(--muted)] text-sm">
									The closest sections are:
								</p>
								<div className="mt-3 flex flex-wrap justify-center gap-2">
									{suggestions.map((s) => (
										<button
											key={s.id}
											type="button"
											onClick={() => {
												setQuery('');
												jumpTo(s.id);
											}}
											className="btn-ghost rounded-lg border px-3 py-1.5 text-sm"
										>
											{s.title}
										</button>
									))}
								</div>
							</>
						) : (
							<p className="mt-1 text-[color:var(--muted)] text-sm">
								Search covers the full text, so try a phrase you remember — “api
								key”, “salt window”, “data-facet-ignore”, “signed export”.
							</p>
						)}
					</div>
				) : null}
			</div>
		</div>
	);
}

/** One rendered section, with a copy-link affordance so a specific answer can be shared. */
function DocSection({ section }: { section: Section }): ReactElement {
	const [copied, copy] = useCopy();
	return (
		<section
			id={`doc-${section.id}`}
			aria-labelledby={`doc-${section.id}-h`}
			className="surface group scroll-mt-20 rounded-xl p-5"
		>
			<div className="flex items-start justify-between gap-2">
				<h2
					id={`doc-${section.id}-h`}
					className="font-semibold text-[color:var(--ink)] text-base"
				>
					{section.title}
				</h2>
				<button
					type="button"
					onClick={() => {
						const { origin, pathname, search } = window.location;
						copy(`${origin}${pathname}${search}${HASH_PREFIX}${section.id}`);
					}}
					aria-label={copied ? 'Link copied' : `Copy link to ${section.title}`}
					className="shrink-0 rounded-md p-1.5 text-[color:var(--muted)] opacity-0 transition hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)] focus-visible:opacity-100 group-hover:opacity-100"
				>
					{copied ? (
						<Check className="h-3.5 w-3.5 text-pos" aria-hidden="true" />
					) : (
						<Link2 className="h-3.5 w-3.5" aria-hidden="true" />
					)}
				</button>
			</div>
			<div className="mt-1">{section.body}</div>
		</section>
	);
}
