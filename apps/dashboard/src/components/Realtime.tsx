// Realtime view: active-visitor proxy over the trailing window, auto-refreshing every 15s and pausing
// while the tab is hidden (see useRealtime). Active visitors are a privacy-safe distinct-hash proxy,
// deduped within the window — no cookies, no persistent id.
//
// The counters alone answered "how many", never "what/where", so this also renders the live
// breakdowns for the same trailing window (pages, events, referrers, countries, devices, channels)
// from the narrow realtime-context endpoint, plus a rolling sparkline accumulated from successive
// polls so a trend is visible.

import type { CountRow } from '@facet/shared';
import { ArrowDownRight, ArrowUpRight, CheckCircle2, Minus, Pause, Play } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import {
	REFETCH_MS,
	useRealtime,
	useRealtimeBreakdown,
	useRecentActivity,
	useVisible,
} from '../hooks/realtime.js';
import { useSegment } from '../hooks/segment.js';
import { cn } from '../lib/cn.js';
import { clockLabel, formatElapsed, formatTimeOfDay, useClockMode } from '../lib/datetime.js';
import { formatNumber } from '../lib/format.js';
import { isAuthError } from '../lib/status.js';
import { useThemeColors } from '../theme.js';
import { SegmentNotice } from './CubeFilterBar.js';
import { Sparkline } from './Sparkline.js';
import { AuthErrorBanner, CardSkeletons, EmptyState, ErrorState } from './StatusStates.js';
import { TopList } from './TopList.js';

/** How many polls of history the live sparkline keeps (12 samples at 15s ≈ the last 3 minutes). */
const HISTORY = 12;

/**
 * Below this many pageviews in the trailing 24 hours a site is treated as freshly installed, and the
 * tab states plainly that the snippet is working. Above it the confirmation would be noise — an
 * established site's operator is not asking whether tracking runs.
 */
const NEW_SITE_PAGEVIEWS = 200;

/** Round to a whole minute so the breakdown query key is stable between the 15s counter refreshes —
 * otherwise every poll would mint a new react-query key and refetch all four breakdowns. */
const BUCKET_MS = 60_000;

/** One accumulated poll: the two counters plus when they were observed, so the trend can say how far
 * back it is comparing to rather than an unlabelled "vs earlier". */
interface History {
	stamps: number[];
	visitors: number[];
	pageviews: number[];
}

const EMPTY_HISTORY: History = { stamps: [], visitors: [], pageviews: [] };

/**
 * Whether a sample series is worth drawing. Sparkline normalises against its own min/max, so a series
 * where every value is equal renders as a flat line pinned to the BOTTOM of the box — which reads as
 * "at zero" when the value may well be 40. A constant series carries no shape, so show none; the
 * trend badge already states that nothing moved.
 */
export function hasVariance(values: number[]): boolean {
	if (values.length < 2) return false;
	return values.some((v) => v !== values[0]);
}

/** Signed change of a counter against the oldest sample still in the rolling window. */
function TrendBadge({ change, since }: { change: number; since: string }): ReactElement {
	const Icon = change === 0 ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;
	const tone = change === 0 ? 'badge-neutral' : change > 0 ? 'badge-pos' : 'badge-neg';
	const sign = change > 0 ? '+' : '';
	return (
		<span
			className={cn(
				'mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold text-[11px] tabular-nums',
				tone,
			)}
		>
			<Icon className="h-3 w-3" aria-hidden="true" />
			<span>{change === 0 ? 'no change' : `${sign}${formatNumber(change)}`}</span>
			<span data-chrome className="font-normal opacity-75">
				vs {since} ago
			</span>
		</span>
	);
}

function Metric({
	label,
	value,
	hint,
	spark,
	stroke,
	change,
	since,
}: {
	label: string;
	value: string;
	hint?: string;
	spark?: number[];
	stroke?: string;
	/** Signed change vs the oldest retained poll; omitted until there are two polls to compare. */
	change?: number;
	since?: string;
}): ReactElement {
	return (
		<div className="surface rounded-2xl p-6">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<div
						data-chrome
						className="font-medium text-[13px] text-[color:var(--muted)]"
						title={hint}
					>
						{label}
					</div>
					<div className="mt-2 font-semibold text-4xl text-[color:var(--ink)] tracking-tight tabular-nums">
						{value}
					</div>
					{change != null && since ? <TrendBadge change={change} since={since} /> : null}
				</div>
				{spark && hasVariance(spark) ? (
					<Sparkline values={spark} width={120} height={40} stroke={stroke} fill marker />
				) : null}
			</div>
		</div>
	);
}

/**
 * Ring + seconds until the next poll. The 1s tick lives inside this component on purpose: hoisting it
 * would re-render the four breakdown lists (which measure themselves) once a second for a countdown
 * nobody asked them to show.
 */
function RefreshMeter({ since, live }: { since: number; live: boolean }): ReactElement {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!live) return;
		// Resync immediately: coming back from a pause, `now` is as stale as the pause was long.
		setNow(Date.now());
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [live]);

	const remaining = live && since ? Math.max(0, since + REFETCH_MS - now) : REFETCH_MS;
	const progress = 1 - remaining / REFETCH_MS;
	const circumference = 2 * Math.PI * 6;

	return (
		<span
			data-chrome
			className="inline-flex items-center gap-1.5 text-[color:var(--muted)] text-xs tabular-nums"
			// Not a live region: a countdown that announced itself every second would make the tab
			// unusable with a screen reader. The counts themselves are announced instead.
			aria-hidden="true"
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 16 16"
				className="-rotate-90 shrink-0"
				aria-hidden="true"
				focusable="false"
			>
				<circle
					cx="8"
					cy="8"
					r="6"
					fill="none"
					stroke="rgb(var(--border))"
					strokeWidth="2"
				/>
				{live ? (
					<circle
						cx="8"
						cy="8"
						r="6"
						fill="none"
						stroke="var(--d1)"
						strokeWidth="2"
						strokeLinecap="round"
						strokeDasharray={circumference.toFixed(2)}
						strokeDashoffset={(circumference * (1 - progress)).toFixed(2)}
					/>
				) : null}
			</svg>
			{live ? `${Math.ceil(remaining / 1000)}s` : 'Paused'}
		</span>
	);
}

export function Realtime({
	apiKey,
	siteId,
}: {
	apiKey: string;
	siteId: string;
}): ReactElement {
	const [paused, setPaused] = useState(false);
	const visible = useVisible();
	const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = useRealtime(
		apiKey,
		siteId,
		paused,
	);
	const colors = useThemeColors();
	useClockMode();

	// Rolling history of the last few polls, so the two counters show a trend rather than a bare
	// number. Kept client-side only: the realtime endpoint returns a single snapshot, not a series.
	const [history, setHistory] = useState<History>(EMPTY_HISTORY);
	const { segment, active: segmentActive } = useSegment();
	const lastStampRef = useRef<number>(0);
	// Reset the trend whenever the site changes — one site's history must never tail into another's.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed intentionally on the site alone
	useEffect(() => {
		setHistory(EMPTY_HISTORY);
		lastStampRef.current = 0;
	}, [siteId]);
	useEffect(() => {
		if (!data || !dataUpdatedAt || dataUpdatedAt === lastStampRef.current) return;
		lastStampRef.current = dataUpdatedAt;
		setHistory((prev) => ({
			stamps: [...prev.stamps, dataUpdatedAt].slice(-HISTORY),
			visitors: [...prev.visitors, data.visitors].slice(-HISTORY),
			pageviews: [...prev.pageviews, data.pageviews].slice(-HISTORY),
		}));
	}, [data, dataUpdatedAt]);

	const isEmpty = Boolean(data) && data?.visitors === 0 && data?.pageviews === 0;

	// Live breakdowns over the same trailing window, from the narrow context endpoint. Skipped while
	// the window is empty: the same window that reported zero pageviews cannot have any top rows.
	const until = data ? Math.floor(data.until / BUCKET_MS) * BUCKET_MS : 0;
	const windowMs = data?.window_ms ?? 0;
	// The segment reaches the breakdowns but not the counters above
	// (which come from an endpoint that takes site_id and nothing else) — SegmentNotice says so.
	const breakdown = useRealtimeBreakdown(
		apiKey,
		siteId,
		until - windowMs,
		until,
		!isEmpty,
		segment,
	);
	// The trailing-24h volume, used for both halves of the first-run question: with an empty window it
	// tells "quiet right now" apart from "nothing is arriving", and with a live window it tells a
	// brand-new install (which needs to be told, once, that its snippet works) from an established
	// site (which does not). Hourly-bucketed key and a one-hour staleTime, so it is one request.
	const recent = useRecentActivity(apiKey, siteId, true);
	// A site with almost no history that is nevertheless receiving events right now is somebody who
	// installed the snippet minutes ago. That is the highest-stakes moment in the product, and the
	// counters alone do not answer the question actually being asked: "is that MY traffic?".
	const justInstalled =
		!isEmpty && recent.data != null && recent.data.pageviews < NEW_SITE_PAGEVIEWS;

	if (error && isAuthError(error)) {
		return <AuthErrorBanner />;
	}
	if (error) {
		return (
			<ErrorState
				message="Could not load realtime data"
				detail={error instanceof Error ? error.message : null}
				onRetry={() => void refetch()}
				retrying={isFetching}
			/>
		);
	}
	if (isLoading || !data) {
		return <CardSkeletons count={3} />;
	}

	// Live means "the poll is actually running": the user's pause and a backgrounded tab both stop it.
	const live = !paused && visible;
	// "Updated 14:32 CEST" — the clock is named here too, because this is the one timestamp on the tab
	// a reader checks against their own watch to decide whether the page is stuck.
	const updated = dataUpdatedAt ? `${formatTimeOfDay(dataUpdatedAt)} ${clockLabel()}` : '—';
	const minutes = Math.max(1, Math.round(data.window_ms / 60_000));
	// Pageviews per minute over the window — the rate reads better than the raw count at a glance.
	const perMinute = data.pageviews / minutes;

	// Trend vs the oldest poll still retained. Both endpoints of the comparison are the same trailing
	// window measured at two times, so this is honestly "how the live number moved", not a period delta.
	const spanMs = history.stamps.length > 1 ? dataUpdatedAt - (history.stamps[0] ?? 0) : 0;
	const since = spanMs > 0 ? formatElapsed(spanMs) : null;
	const visitorChange = since ? data.visitors - (history.visitors[0] ?? 0) : undefined;
	const pageviewChange = since ? data.pageviews - (history.pageviews[0] ?? 0) : undefined;

	const lists: { title: string; rows: CountRow[] }[] = [
		{ title: 'Active pages', rows: breakdown.data?.top_paths ?? [] },
		{ title: 'Recent events', rows: breakdown.data?.top_events ?? [] },
		{ title: 'Sources', rows: breakdown.data?.top_referrers ?? [] },
		{ title: 'Geography', rows: breakdown.data?.top_countries ?? [] },
		{ title: 'Devices', rows: breakdown.data?.top_devices ?? [] },
		{ title: 'Channels', rows: breakdown.data?.channels ?? [] },
	];
	const hasBreakdown = lists.some((l) => l.rows.length > 0);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="inline-flex items-center gap-2 font-medium text-[color:var(--ink)] text-sm">
					<span className="relative inline-flex size-2.5" aria-hidden="true">
						{isFetching ? (
							<span className="absolute inline-flex size-full animate-ping rounded-full bg-[color:var(--pos)] opacity-70" />
						) : null}
						<span
							className="relative inline-flex size-2.5 rounded-full"
							style={{ backgroundColor: live ? 'var(--pos)' : 'var(--faint)' }}
						/>
					</span>
					{live ? 'Live' : 'Paused'} · last {minutes} min
				</span>
				<span className="flex flex-wrap items-center gap-3">
					<RefreshMeter since={dataUpdatedAt} live={live} />
					<button
						type="button"
						onClick={() => setPaused((p) => !p)}
						aria-pressed={paused}
						className="btn-ghost inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-medium text-xs"
						title={
							paused
								? 'Resume the 15s auto-refresh'
								: 'Hold the current numbers still'
						}
					>
						{paused ? (
							<Play className="h-3.5 w-3.5" aria-hidden="true" />
						) : (
							<Pause className="h-3.5 w-3.5" aria-hidden="true" />
						)}
						{paused ? 'Resume' : 'Pause'}
					</button>
					<span data-chrome className="text-[color:var(--muted)] text-xs">
						Updated {updated}
					</span>
				</span>
			</div>

			{justInstalled ? (
				<p className="alert-ok flex items-start gap-2 rounded-lg p-3 text-sm">
					<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
					<span>
						<strong>Your snippet is live.</strong> Facet has received{' '}
						{formatNumber(data.pageviews)}{' '}
						{data.pageviews === 1 ? 'pageview' : 'pageviews'} from this site in the last{' '}
						{minutes} minutes, so tracking is installed and reporting. This confirmation
						stops showing once the site is past {formatNumber(NEW_SITE_PAGEVIEWS)}{' '}
						pageviews a day.
					</span>
				</p>
			) : null}

			{/* Placed above the counters, because the counters are the half that cannot be scoped. */}
			<SegmentNotice tab="realtime" />

			{/* The one live region on the page. It re-announces only when the text below actually
			    changes, so an idle site stays silent instead of interrupting every 15 seconds. */}
			<output className="sr-only" aria-live="polite">
				{isEmpty
					? `No active visitors in the last ${minutes} minutes.`
					: `${formatNumber(data.visitors)} active visitors, ${formatNumber(data.pageviews)} pageviews in the last ${minutes} minutes.`}
			</output>

			{isEmpty ? (
				<EmptyState title="No active visitors right now">
					<RecentActivityNote
						minutes={minutes}
						pageviews={recent.data?.pageviews}
						isLoading={recent.isLoading}
						isError={Boolean(recent.error)}
					/>
				</EmptyState>
			) : (
				<>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						<Metric
							label={`Active visitors, last ${minutes} min`}
							value={formatNumber(data.visitors)}
							hint={`Distinct visitor hashes seen in the last ${minutes} minutes — a privacy-safe proxy, deduped within the window. No cookies, no persistent id.`}
							spark={history.visitors}
							stroke={colors.d1}
							change={visitorChange}
							since={since ?? undefined}
						/>
						<Metric
							label={`Pageviews, last ${minutes} min`}
							value={formatNumber(data.pageviews)}
							spark={history.pageviews}
							stroke={colors.d2}
							change={pageviewChange}
							since={since ?? undefined}
						/>
						<Metric
							label="Pageviews per minute"
							value={
								perMinute >= 10
									? formatNumber(Math.round(perMinute))
									: perMinute.toFixed(1)
							}
							hint="Pageviews in the window divided by the window length."
						/>
					</div>

					{breakdown.error ? (
						// The counters loaded, so the key is fine and the page is not broken — say which
						// half failed rather than silently rendering nothing where four lists belong.
						<div className="space-y-2">
							<ErrorState
								message="Live breakdowns could not be loaded"
								detail={
									breakdown.error instanceof Error
										? breakdown.error.message
										: null
								}
							/>
							<button
								type="button"
								onClick={() => void breakdown.refetch()}
								disabled={breakdown.isFetching}
								className="btn-ghost rounded-lg px-2.5 py-1 font-medium text-xs"
							>
								{breakdown.isFetching ? 'Retrying…' : 'Retry'}
							</button>
						</div>
					) : hasBreakdown ? (
						<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
							{lists.map((list) => (
								<TopList
									key={list.title}
									// These four lists are the tab's top-level sections; at h3 they
									// skipped a level straight from the view's h1.
									headingLevel={2}
									// Say it on the tile too: these four ARE scoped, the counters
									// above are not, and one heading each is how a reader can tell
									// them apart without re-reading the notice.
									title={
										segmentActive
											? `${list.title} right now, in segment`
											: `${list.title} right now`
									}
									rows={list.rows}
									limit={6}
								/>
							))}
						</div>
					) : breakdown.isLoading ? (
						<CardSkeletons count={4} />
					) : null}
				</>
			)}

			<p data-chrome className="text-[color:var(--muted)] text-xs">
				Active visitors is a privacy-safe distinct-hash proxy, deduped within the {minutes}
				-minute window — not a precise count. The trend is measured against this session's
				own polls, not a previous period. Activity modules are bounded aggregates from the
				same trailing window, not a visitor-level event feed. Auto-refreshes every 15s,
				retries transient failures, and pauses while this tab is hidden.
			</p>
		</div>
	);
}

/**
 * The empty state's second line. "No visitors right now" means two very different things depending on
 * whether anything has arrived at all, and the snapshot alone cannot tell them apart — so the 24h
 * summary decides between "it's just quiet" and "check the snippet".
 */
function RecentActivityNote({
	minutes,
	pageviews,
	isLoading,
	isError,
}: {
	minutes: number;
	pageviews?: number;
	isLoading: boolean;
	isError: boolean;
}): ReactElement {
	if (isLoading) {
		return <span>Checking whether this site has reported recently…</span>;
	}
	if (isError || pageviews == null) {
		return (
			<span>
				Visitors from the last {minutes} minutes appear here. This view refreshes every 15
				seconds.
			</span>
		);
	}
	if (pageviews > 0) {
		return (
			<span>
				Tracking is reporting — {formatNumber(pageviews)} pageviews in the last 24 hours. It
				is just quiet in the last {minutes} minutes.
			</span>
		);
	}
	return (
		<span>
			Nothing at all has reached Facet from this site in the last 24 hours. That is either a
			snippet that never ran or a site with no visitors yet, and this view cannot tell them
			apart on its own — so tell them apart directly: open your site in another tab, then come
			back here. If this counter moves within {minutes} minutes, tracking works and you simply
			have no visitors. If it does not, check the tracking snippet is installed on the page
			and that <code>/api/collect</code> returns <code>202</code> in your browser's network
			panel — the Documentation tab has the embed and the troubleshooting list.
		</span>
	);
}
