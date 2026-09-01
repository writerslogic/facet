// Root dashboard component: KeyGate until at least one site profile exists, otherwise the app shell
// with the read tabs plus a self-service Settings area. Read queries are keyed by site id, and the
// react-query cache is reset when the active profile changes so one site's data never flashes under
// another site's label.

import type { CubeCell, StatsQuery } from '@facet/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useAdmin } from './admin.js';
import { BentoBoard, BentoSkeleton } from './components/BentoBoard.js';
import { CubeFilterBar, SegmentBar } from './components/CubeFilterBar.js';
import { ExportButton } from './components/ExportButton.js';
import { KeyGate } from './components/KeyGate.js';
import { Layout } from './components/Layout.js';
import { ShortcutHelp } from './components/ShortcutHelp.js';
import { AuthErrorBanner, ErrorState } from './components/StatusStates.js';

// The heavy read tabs are code-split: only the Overview (inline below) ships in the initial bundle;
// every other tab's JS loads on first view, cutting the JavaScript-to-interactive on the page that
// actually loads first. Named exports are adapted to the default-export shape `lazy` expects.
const AllSites = lazy(() =>
	import('./components/AllSites.js').then((m) => ({ default: m.AllSites })),
);
const Anomalies = lazy(() =>
	import('./components/Anomalies.js').then((m) => ({ default: m.Anomalies })),
);
const Crm = lazy(() => import('./components/Crm.js').then((m) => ({ default: m.Crm })));
const AskPanel = lazy(() =>
	import('./components/AskPanel.js').then((m) => ({ default: m.AskPanel })),
);
const Docs = lazy(() => import('./components/Docs.js').then((m) => ({ default: m.Docs })));
const Explore = lazy(() => import('./components/Explore.js').then((m) => ({ default: m.Explore })));
const Experiments = lazy(() =>
	import('./components/Experiments.js').then((m) => ({
		default: m.Experiments,
	})),
);
const FunnelsView = lazy(() =>
	import('./components/FunnelsView.js').then((m) => ({
		default: m.FunnelsView,
	})),
);
const Realtime = lazy(() =>
	import('./components/Realtime.js').then((m) => ({ default: m.Realtime })),
);
const Retention = lazy(() =>
	import('./components/Retention.js').then((m) => ({ default: m.Retention })),
);
const Settings = lazy(() =>
	import('./components/Settings.js').then((m) => ({ default: m.Settings })),
);

/** Fallback shown while a lazily-loaded tab's JS chunk is fetched (keeps the shell from shifting). */
function TabFallback(): ReactElement {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center text-[color:var(--muted)] text-sm">
			<span className="animate-pulse">Loading…</span>
		</div>
	);
}
import {
	useCreateTimelineAnnotation,
	useDeleteTimelineAnnotation,
	useTimelineAnnotations,
} from './hooks/annotations.js';
import { useAnomalies } from './hooks/anomaly.js';
import { useCube } from './hooks/cube.js';
import { SegmentProvider, useSegment } from './hooks/segment.js';
import { useCompareStats, useStats } from './hooks/stats.js';
import { cn } from './lib/cn.js';
import {
	type CubeAxis,
	type CubeFilter,
	type ServerFilter,
	cubeBreakdown,
	cubeSeries,
	isFilterActive,
	sliceCube,
} from './lib/cube.js';
import { toggleClockMode } from './lib/datetime.js';
import { queryKeyReferencesSite } from './lib/queryKeys.js';
import {
	type Segment,
	type SegmentKey,
	needsServer,
	segmentParams,
	toCubeFilter,
	toServerFilter,
} from './lib/segment.js';
import { ASK_INPUT_ID, matchShortcut } from './lib/shortcuts.js';
import { isAuthError } from './lib/status.js';
import type { TileContext } from './lib/tiles.js';
import { useDashboard } from './state.js';

type View =
	| 'overview'
	| 'explore'
	| 'allsites'
	| 'realtime'
	| 'funnels'
	| 'retention'
	| 'experiments'
	| 'anomalies'
	| 'crm'
	| 'ask'
	| 'docs';

/** URL parameter carrying the open tab, so a reload — or a shared link — lands where the reader was. */
const TAB_PARAM = 'tab';

/**
 * The tab to open on first render. Two sources, in priority order:
 *
 *   - `#doc-<section>`, the documentation deep link: a shared link must land on the Documentation tab
 *     rather than dropping the reader on the Overview with a hash that resolves to nothing.
 *   - `?tab=<id>`, written on every tab change. The range and the segment were already in the URL, so
 *     a refresh restored the window and the filter but silently threw you back to the Overview —
 *     two-thirds of a restored view, which is worse than none because it looks intentional.
 *
 * Read once, at mount: the tab is state from then on.
 */
function initialView(): View {
	if (typeof window === 'undefined') return 'overview';
	if (window.location.hash.startsWith('#doc-')) return 'docs';
	const raw = new URLSearchParams(window.location.search).get(TAB_PARAM);
	return TABS.some((tab) => tab.id === raw) ? (raw as View) : 'overview';
}

/** Mirror the open tab into the URL. `replaceState`, matching how the range and segment are written:
 * a tab change is not a navigation and must not fill the Back button with dashboard states. */
function writeViewToUrl(view: View): void {
	const url = new URL(window.location.href);
	if (view === 'overview') url.searchParams.delete(TAB_PARAM);
	else url.searchParams.set(TAB_PARAM, view);
	window.history.replaceState(null, '', url);
}

/**
 * Put the cursor in the Ask box after the `A` shortcut switches to it. The tab is code-split, so the
 * input does not exist for some frames after the state change — hence a bounded retry rather than a
 * single lookup. Gives up after ~1s so a failed chunk load can't leave a frame loop running.
 */
function focusAskInput(): void {
	let attempts = 0;
	const attempt = (): void => {
		const el = document.getElementById(ASK_INPUT_ID);
		if (el) {
			el.focus();
			return;
		}
		if (++attempts < 60) requestAnimationFrame(attempt);
	};
	requestAnimationFrame(attempt);
}

// Stable empty reference so `cube.data?.cells ?? EMPTY_CELLS` keeps the same identity across renders
// (a fresh `[]` would defeat memoization of everything derived from the cube).
const EMPTY_CELLS: CubeCell[] = [];

const TABS: { id: View; label: string }[] = [
	{ id: 'overview', label: 'Overview' },
	{ id: 'explore', label: 'Explore' },
	{ id: 'allsites', label: 'All sites' },
	{ id: 'realtime', label: 'Realtime' },
	{ id: 'funnels', label: 'Funnels' },
	{ id: 'retention', label: 'Retention' },
	{ id: 'experiments', label: 'Experiments' },
	{ id: 'anomalies', label: 'Anomalies' },
	{ id: 'crm', label: 'CRM' },
	{ id: 'ask', label: 'Ask' },
	{ id: 'docs', label: 'Documentation' },
];

/**
 * Roving-tabindex arrow navigation for the view tabs, matching what the Settings tablist already does.
 * A `role="tablist"` promises arrow-key navigation to assistive tech; this strip had nine tab stops and
 * inert arrow keys, so the promise was false and it was also the slowest thing in the app to traverse.
 * Returns true when the key was consumed, so the caller can suppress the page scroll.
 */
function onViewTabKey(key: string, current: View, select: (id: View) => void): boolean {
	const index = TABS.findIndex((t) => t.id === current);
	if (index < 0) return false;
	let next: number;
	if (key === 'ArrowRight') next = (index + 1) % TABS.length;
	else if (key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
	else if (key === 'Home') next = 0;
	else if (key === 'End') next = TABS.length - 1;
	else return false;
	const target = TABS[next];
	if (!target) return false;
	select(target.id);
	document.getElementById(`view-tab-${target.id}`)?.focus();
	return true;
}

function Overview({
	onOpenSettings,
	editing,
	onEditingChange,
}: {
	onOpenSettings: () => void;
	editing: boolean;
	onEditingChange: (next: boolean) => void;
}): ReactElement {
	const { apiKey, siteId, preset, range, isDemo } = useDashboard();
	const admin = useAdmin();
	// The segment is shared state now, read straight from context rather than threaded down: the
	// Overview is one of eight readers, not its owner.
	const { segment, toggle } = useSegment();
	const cubeFilter: CubeFilter = toCubeFilter(segment);
	const serverFilter: ServerFilter = toServerFilter(segment);
	const interval = preset === '24h' ? 'hour' : 'day';

	// Server-filter mode: a high-cardinality path/referrer filter is active, so the whole Overview is
	// re-fetched server-side (the cube can't slice these). Active cube dims (device/country/channel) are
	// sent along so a segment + drill-down combine. Absent path/referrer, the instant client cube runs.
	const serverMode = needsServer(segment);
	// A cube slice or server drill-down is active. The period-comparison column is meaningless under a
	// filter (the compare query isn't sliced), so it's both hidden AND not fetched while filtering.
	const cubeActive = isFilterActive(cubeFilter) && !serverMode;
	const anyFilter = cubeActive || serverMode;
	const query: StatsQuery = {
		site_id: siteId,
		start: range.start,
		end: range.end,
		interval,
		// In server mode the WHOLE segment travels to /api/stats, which applies all five dimensions
		// (toStatsFilter → buildFilteredEventWhere), so a path drill-down and a device slice combine.
		...(serverMode ? segmentParams(segment) : {}),
	};

	// Gate on the site too, not just the key: `site_id=` fails StatsQuerySchema's uuid check with a
	// 400. Every sibling hook already gates on both; this was the odd one out.
	const { data, isLoading, error, isFetching, refetch } = useStats(
		apiKey,
		query,
		Boolean(siteId),
	);
	// Always fetch the equal-length preceding period so KPI deltas are always on (no "Compare" toggle
	// needed); skipped only while filtering, where the comparison window isn't sliced to match.
	const prevSpan = range.end - range.start;
	const compareQuery: StatsQuery = {
		site_id: siteId,
		start: range.start - prevSpan,
		end: range.start,
		interval,
	};
	const compareStats = useCompareStats(apiKey, compareQuery, !anyFilter);
	const cube = useCube(apiKey, siteId, range, interval);
	// Anomalies are layered onto the traffic chart as timeline markers (shared cache with the tab).
	const anomalies = useAnomalies(apiKey, siteId, range);
	const timelineAnnotations = useTimelineAnnotations(apiKey, siteId, range);
	const createAnnotation = useCreateTimelineAnnotation(admin.token, siteId);
	const deleteAnnotation = useDeleteTimelineAnnotation(admin.token, siteId);

	if (error && isAuthError(error)) {
		return <AuthErrorBanner />;
	}

	if (error) {
		return (
			<ErrorState
				message="Could not load analytics"
				detail={error instanceof Error ? error.message : null}
				onRetry={() => void refetch()}
				retrying={isFetching}
			/>
		);
	}

	if (isLoading || !data) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<BentoSkeleton siteId={siteId} />
			</div>
		);
	}

	const summary = data.summary;
	const isEmpty = summary.pageviews === 0 && summary.visitors === 0 && summary.events === 0;
	const cmp = compareStats.data ?? null;

	// Instant client-side slicing over the in-memory cube. When a filter is active, the KPIs and chart
	// render from the sliced cube (no server round-trip); pageviews/events are exact, visitors is an
	// upper bound flagged below. Engagement is session-derived (not in the cube), so it hides under a
	// filter rather than showing unfiltered numbers next to filtered ones.
	const cubeCells = cube.data?.cells ?? EMPTY_CELLS;
	// In serverMode the fetched `data` is already fully filtered server-side, so use it directly; else
	// the cube slices client-side. `cubeActive`/`anyFilter` are computed above (they gate the compare fetch).
	const slice = cubeActive ? sliceCube(cubeCells, cubeFilter) : null;
	const displaySummary = slice
		? {
				pageviews: slice.pageviews,
				visitors: slice.visitors,
				events: slice.events,
			}
		: summary;
	const displaySeries = cubeActive ? cubeSeries(cubeCells, cubeFilter) : data.series;
	const operatorNotes = timelineAnnotations.data?.annotations ?? [];
	const chartAnnotations = [
		...(anomalies.data?.anomalies ?? []).map((anomaly) => ({
			t: anomaly.bucket,
			label: anomaly.summary,
			kind: 'anomaly' as const,
		})),
		...operatorNotes.map((note) => ({
			t: note.occurred_at,
			label: note.label,
			kind: 'note' as const,
			category: note.category,
		})),
	].sort((a, b) => a.t - b.t);

	// KPI deltas + sparklines for the bento tiles.
	const cmpSum = anyFilter ? null : cmp?.summary;
	const pct = (cur: number, prev?: number): number | null =>
		prev && prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
	const sense = (d: number | null): 'improvement' | 'regression' | 'neutral' =>
		d == null || d === 0 ? 'neutral' : d > 0 ? 'improvement' : 'regression';
	const sparkPv = displaySeries.map((p) => p.pageviews);
	const sparkVis = displaySeries.map((p) => p.visitors);
	// Events isn't in the server series, so its sparkline re-buckets over the cube (respecting an active
	// cube filter, matching how pv/vis reflect the current slice).
	const sparkEv = cubeCells.length
		? cubeSeries(cubeCells, cubeActive ? cubeFilter : {}).map((p) => p.events)
		: [];
	const dPv = pct(displaySummary.pageviews, cmpSum?.pageviews);
	const dVis = pct(displaySummary.visitors, cmpSum?.visitors);
	const dEv = pct(displaySummary.events, cmpSum?.events);

	// Cross-filter handlers: cube dims slice instantly; path/referrer refetch server-side. Both are
	// now the same `toggle` on the shared segment — the only difference is which axis it names.
	const hasCube = cubeCells.length > 0;
	const toggleCube = (axis: CubeAxis) => (key: string) => toggle(axis, key);
	const toggleServer = (key: keyof ServerFilter) => (value: string) =>
		toggle(key as SegmentKey, value);
	const dimRows = (axis: CubeAxis, fallback: typeof data.top_countries) =>
		!serverMode && hasCube ? cubeBreakdown(cubeCells, cubeFilter, axis) : fallback;
	const dimSelect = (axis: CubeAxis) => (hasCube || serverMode ? toggleCube(axis) : undefined);

	const filterBar = <CubeFilterBar cells={cubeCells} />;

	// No data yet: still render the real bento (all tiles are zero/empty-safe) so the layout never
	// collapses to a different shape — a slim, non-blocking banner carries the setup CTA over the board.
	const boardEmpty = isEmpty && data.series.length === 0;

	const ctx: TileContext = {
		summary: displaySummary,
		series: displaySeries,
		annotations: chartAnnotations,
		annotationManager: {
			notes: operatorNotes,
			range,
			canManage: admin.hasToken && !isDemo,
			readOnlyReason: isDemo ? 'demo' : admin.hasToken ? null : 'missing-admin',
			isLoading: timelineAnnotations.isLoading,
			isSaving: createAnnotation.isPending,
			isDeleting: deleteAnnotation.isPending,
			loadError:
				timelineAnnotations.error instanceof Error
					? timelineAnnotations.error.message
					: null,
			mutationError:
				createAnnotation.error instanceof Error
					? createAnnotation.error.message
					: deleteAnnotation.error instanceof Error
						? deleteAnnotation.error.message
						: null,
			create: async (input) => {
				await createAnnotation.mutateAsync({ site_id: siteId, ...input });
			},
			remove: async (id) => {
				await deleteAnnotation.mutateAsync(id);
			},
			requestAdmin: onOpenSettings,
		},
		deltas: { pv: dPv, vis: dVis, ev: dEv },
		sparks: { pv: sparkPv, vis: sparkVis, ev: sparkEv },
		sense,
		flowCells: cubeCells,
		data,
		engagement: data.engagement,
		anyFilter,
		cubeFilter,
		serverFilter,
		toggleServer,
		dimRows,
		dimSelect,
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			{boardEmpty ? (
				// The setup CTA replaces the filter bar, but it must not replace the INDICATOR: an
				// empty board under an active segment is a claim ("nothing matches this filter")
				// and the reader needs to see — and be able to drop — the filter that produced it.
				<>
					<div className="flex shrink-0 items-center justify-between gap-3 rounded-xl chip-active border px-4 py-2.5 text-sm">
						<span>
							Nothing has reached Facet for this site yet. Add the tracking snippet,
							then load a page on your own site — the Realtime tab confirms the first
							event within seconds.
						</span>
						<button
							type="button"
							onClick={onOpenSettings}
							className="shrink-0 rounded-lg btn-accent px-3 py-1.5 text-xs transition"
						>
							Set up a site
						</button>
					</div>
					{filterBar}
				</>
			) : (
				filterBar
			)}
			<BentoBoard
				ctx={ctx}
				siteId={siteId}
				editing={editing}
				onEditingChange={onEditingChange}
				footer={
					slice?.visitorsApproximate ? (
						<p className="shrink-0 text-xs text-[color:var(--faint)]">
							Visitors is an upper bound under this slice; pageviews and events are
							exact.
						</p>
					) : null
				}
			/>
		</div>
	);
}

/** Header pill shown only on the public demo deployment: signals the data is a live demo and links to
 * the repo so a visitor can deploy their own. Rendered via `isDemo` from the store. */
function DemoBadge(): ReactElement {
	return (
		<a
			href="https://github.com/writerslogic/facet"
			target="_blank"
			rel="noopener noreferrer"
			data-chrome
			className="chip-active inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium text-sm transition"
		>
			<span
				className="size-1.5 animate-pulse rounded-full bg-[color:var(--chip-ink)]"
				aria-hidden="true"
			/>
			Live demo · Deploy your own →
		</a>
	);
}

function Dashboard(): ReactElement {
	const { apiKey, siteId, preset, range, isDemo, setPreset } = useDashboard();
	const [view, setView] = useState<View>(initialView);
	const [showSettings, setShowSettings] = useState(false);
	// Board layout editing is driven from Settings ("Edit layout"), so the flag lives above both the
	// Settings panel that turns it on and the Overview that renders it.
	const [boardEditing, setBoardEditing] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	// The segment is shared state (see hooks/segment.ts), so it survives tab switches and can be set
	// from any tab — e.g. "Investigate" on an anomaly focuses the Overview on the culprit segment.
	// Also read here (not just set) so the header's ExportButton can forward it to /stats/export —
	// otherwise a CSV taken while the board is cross-filtered would silently export the whole site.
	const { segment, setSegment, clear: clearSegment } = useSegment();
	// Unchanged contract: replace the segment wholesale (dropping any path/referrer drill-down that
	// was in force) and land on the Overview, which is the tab that can actually honour it.
	const investigate = (f: CubeFilter): void => {
		setSegment(f as Segment);
		setView('overview');
	};
	const queryClient = useQueryClient();
	const prevSiteRef = useRef(siteId);

	// Switching site profile must not show the previous site's cached read data. Every read query is
	// keyed by site id, so a new site never reads another site's cache. On an actual switch we also
	// drop the PREVIOUS site's cached read queries so nothing stale lingers — and clear the segment
	// for the same reason: `/pricing` or `US` on one site is not a claim about another one, and a
	// stale chip over another site's numbers is exactly the silent mislabel this feature must avoid.
	useEffect(() => {
		const prevSite = prevSiteRef.current;
		if (prevSite === siteId) return;
		prevSiteRef.current = siteId;
		queryClient.removeQueries({
			predicate: (q) => queryKeyReferencesSite(q.queryKey, prevSite),
		});
		clearSegment();
	}, [siteId, queryClient, clearSegment]);

	// Keep the URL in step with the open tab so a refresh restores it (see `initialView`).
	useEffect(() => {
		writeViewToUrl(view);
	}, [view]);

	// The keyboard layer. Every safety rule (not while typing, no modifiers, no auto-repeat, no IME,
	// nothing already consumed) lives in `matchShortcut`, so this is a pure action table — which is
	// also what makes it impossible for a shortcut to exist that the `?` overlay does not list.
	useEffect(() => {
		function onKeyDown(event: globalThis.KeyboardEvent): void {
			const id = matchShortcut(event);
			if (!id) return;
			// While the overlay is up it owns the keyboard except for its own toggle; Escape is the
			// dialog's (useDialogFocus), which also returns focus to the button that opened it.
			if (shortcutsOpen && id !== 'help') return;
			event.preventDefault();
			switch (id) {
				case 'help':
					setShortcutsOpen((open) => !open);
					return;
				case 'range-24h':
					setPreset('24h');
					return;
				case 'range-7d':
					setPreset('7d');
					return;
				case 'range-30d':
					setPreset('30d');
					return;
				case 'range-90d':
					setPreset('90d');
					return;
				case 'tab-prev':
				case 'tab-next': {
					// Settings is a mode, not a tab: stepping the strip has to leave it, or the keys
					// would silently change a hidden selection.
					setShowSettings(false);
					setView((current) => {
						const index = TABS.findIndex((tab) => tab.id === current);
						const step = id === 'tab-next' ? 1 : -1;
						const next = TABS[(index + step + TABS.length) % TABS.length];
						return next?.id ?? current;
					});
					return;
				}
				case 'go-overview':
					setShowSettings(false);
					setView('overview');
					return;
				case 'go-realtime':
					setShowSettings(false);
					setView('realtime');
					return;
				case 'go-ask':
					setShowSettings(false);
					setView('ask');
					focusAskInput();
					return;
				case 'clear-segment':
					clearSegment();
					return;
				case 'toggle-clock':
					toggleClockMode();
					return;
			}
		}
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [shortcutsOpen, setPreset, clearSegment]);

	// The Overview bento fills the viewport exactly (no page scroll); every other tab scrolls normally.
	const fill = !showSettings && view === 'overview';

	return (
		<Layout
			fill={fill}
			dark
			settingsActive={showSettings}
			onToggleSettings={() => setShowSettings((prev) => !prev)}
			onOpenShortcuts={() => setShortcutsOpen(true)}
			shortcutsOpen={shortcutsOpen}
			headerExtra={
				showSettings ? null : (
					<>
						{isDemo ? <DemoBadge /> : null}
						<ExportButton
							apiKey={apiKey}
							siteId={siteId}
							range={range}
							interval={preset === '24h' ? 'hour' : 'day'}
							segment={segment}
							dark={fill}
						/>
					</>
				)
			}
		>
			{showSettings ? (
				<Suspense fallback={<TabFallback />}>
					{/* Every view owes exactly one h1. There is no visible page title anywhere in this
					    design — the tab strip carries that job visually — so the h1 is for AT only, and
					    is data-chrome so it never lands in a Cmd+A copy of the data. */}
					<h1 data-chrome className="sr-only">
						Settings
					</h1>
					<Settings
						onEditLayout={() => {
							setBoardEditing(true);
							setShowSettings(false);
							setView('overview');
						}}
					/>
				</Suspense>
			) : (
				<>
					<h1 data-chrome className="sr-only">
						{TABS.find((t) => t.id === view)?.label ?? 'Overview'}
					</h1>
					<div
						role="tablist"
						aria-label="Analytics views"
						className="mb-2 flex shrink-0 gap-1 overflow-x-auto border-[color:rgb(var(--border))] border-b"
					>
						{TABS.map((tab) => (
							<button
								key={tab.id}
								type="button"
								role="tab"
								id={`view-tab-${tab.id}`}
								aria-selected={view === tab.id}
								aria-controls={`view-panel-${tab.id}`}
								tabIndex={view === tab.id ? 0 : -1}
								onKeyDown={(e) => {
									if (onViewTabKey(e.key, tab.id, setView)) e.preventDefault();
								}}
								onClick={() => setView(tab.id)}
								className={cn(
									'-mb-px shrink-0 border-b-2 px-4 py-1.5 text-sm font-medium transition-colors',
									view === tab.id
										? 'border-accent-400 text-[color:var(--ink)]'
										: 'border-transparent text-[color:var(--faint)] hover:text-[color:var(--ink)]',
								)}
							>
								{tab.label}
							</button>
						))}
					</div>
					{/* The persistent indicator. The Overview carries its own richer bar (selects +
					    the same chips), so this is the companion for every other tab — one place to
					    see what is applied and one click to drop it, wherever you navigated to. */}
					{view === 'overview' || view === 'allsites' ? null : <SegmentBar />}
					{/* The strip claimed `role="tablist"` with no panel to control: the tabs pointed at
					    nothing, so an AT user could not move from a tab to the content it selected. */}
					<div
						role="tabpanel"
						id={`view-panel-${view}`}
						aria-labelledby={`view-tab-${view}`}
						// Not `display:contents` — a role on a contents box is unreliably exposed. The
						// Overview needs the flex chain to reach the board; every other tab flows.
						className={cn(view === 'overview' && 'flex min-h-0 flex-1 flex-col')}
					>
						<Suspense fallback={<TabFallback />}>
							{view === 'overview' ? (
								<div className="flex min-h-0 flex-1 flex-col">
									<Overview
										onOpenSettings={() => setShowSettings(true)}
										editing={boardEditing}
										onEditingChange={setBoardEditing}
									/>
								</div>
							) : view === 'explore' ? (
								<Explore apiKey={apiKey} siteId={siteId} range={range} />
							) : view === 'allsites' ? (
								<AllSites />
							) : view === 'realtime' ? (
								<Realtime apiKey={apiKey} siteId={siteId} />
							) : view === 'funnels' ? (
								<FunnelsView
									apiKey={apiKey}
									siteId={siteId}
									range={range}
									onOpenSettings={() => setShowSettings(true)}
								/>
							) : view === 'retention' ? (
								<Retention apiKey={apiKey} siteId={siteId} range={range} />
							) : view === 'experiments' ? (
								<Experiments
									apiKey={apiKey}
									siteId={siteId}
									range={range}
									onOpenSettings={() => setShowSettings(true)}
								/>
							) : view === 'anomalies' ? (
								<Anomalies
									apiKey={apiKey}
									siteId={siteId}
									range={range}
									onInvestigate={investigate}
								/>
							) : view === 'crm' ? (
								<Crm siteId={siteId} />
							) : view === 'ask' ? (
								<AskPanel apiKey={apiKey} siteId={siteId} range={range} />
							) : (
								<Docs />
							)}
						</Suspense>
					</div>
				</>
			)}
			{shortcutsOpen ? <ShortcutHelp onClose={() => setShortcutsOpen(false)} /> : null}
		</Layout>
	);
}

export function App(): ReactElement {
	const { activeProfile } = useDashboard();
	if (!activeProfile) return <KeyGate />;
	// The segment provider wraps the whole shell (not just the Overview) — that IS the feature: one
	// selected segment that follows the reader from tab to tab.
	return (
		<SegmentProvider>
			<Dashboard />
		</SegmentProvider>
	);
}
