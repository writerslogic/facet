import type {
	CubeResponse,
	StatsAcquisitionResponse,
	StatsAttributionResponse,
	StatsContentResponse,
	StatsCoreResponse,
	StatsEngagementResponse,
	StatsQuery,
	StatsResponse,
	StatsRevenueResponse,
	StatsSummaryResponse,
	StatsTechnologyResponse,
} from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, qs } from '../../api.js';
import { cubeBreakdown } from '../../lib/cube.js';
import { siteQueryKey } from '../../lib/queryKeys.js';
import type { OverviewRequirement } from './catalog.js';
import type { OverviewRequirements } from './requirements.js';

const EMPTY_ENGAGEMENT = {
	sessions: 0,
	bounce_rate: 0,
	pages_per_session: 0,
	avg_duration_ms: 0,
};

function useOverviewSlice<T>(
	apiKey: string,
	query: StatsQuery,
	requirement: OverviewRequirement,
	path: string,
	enabled: boolean,
) {
	return useQuery({
		queryKey: siteQueryKey(['overview', requirement], query.site_id, query),
		queryFn: () => apiFetch<T>(`${path}?${qs(query)}`, apiKey),
		enabled: Boolean(query.site_id) && enabled,
		staleTime: 60_000,
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[2] === query.site_id ? previous : undefined,
	});
}

export interface OverviewRead {
	data: StatsResponse | undefined;
	cube: CubeResponse | undefined;
	isLoading: boolean;
	isFetching: boolean;
	isPlaceholderData: boolean;
	error: unknown;
	refetch: () => Promise<unknown[]>;
}

/** Execute each stable slice independently. Enabling one requirement adds one cache entry and leaves
 * every existing entry untouched; no combined `fields=` key is invalidated when a layout changes. */
export function useOverviewData(
	apiKey: string,
	query: StatsQuery,
	requirements: OverviewRequirements,
	enabled = true,
): OverviewRead {
	const needs = (requirement: OverviewRequirement): boolean =>
		enabled && requirements.has(requirement);
	const core = useOverviewSlice<StatsCoreResponse>(
		apiKey,
		query,
		'core',
		'/api/stats/core',
		needs('core'),
	);
	const summary = useOverviewSlice<StatsSummaryResponse>(
		apiKey,
		query,
		'summary',
		'/api/stats/summary',
		needs('summary'),
	);
	const cube = useOverviewSlice<CubeResponse>(
		apiKey,
		query,
		'cube',
		'/api/stats/cube',
		needs('cube'),
	);
	const content = useOverviewSlice<StatsContentResponse>(
		apiKey,
		query,
		'content',
		'/api/stats/content',
		needs('content'),
	);
	const acquisition = useOverviewSlice<StatsAcquisitionResponse>(
		apiKey,
		query,
		'acquisition',
		'/api/stats/acquisition',
		needs('acquisition'),
	);
	const technology = useOverviewSlice<StatsTechnologyResponse>(
		apiKey,
		query,
		'technology',
		'/api/stats/technology',
		needs('technology'),
	);
	const engagement = useOverviewSlice<StatsEngagementResponse>(
		apiKey,
		query,
		'engagement',
		'/api/stats/engagement',
		needs('engagement'),
	);
	const revenue = useOverviewSlice<StatsRevenueResponse>(
		apiKey,
		query,
		'revenue',
		'/api/stats/revenue',
		needs('revenue'),
	);
	const attribution = useOverviewSlice<StatsAttributionResponse>(
		apiKey,
		query,
		'attribution',
		'/api/stats/attribution',
		needs('attribution'),
	);

	const reads = [
		{ requirement: 'core' as const, query: core },
		{ requirement: 'summary' as const, query: summary },
		{ requirement: 'cube' as const, query: cube },
		{ requirement: 'content' as const, query: content },
		{ requirement: 'acquisition' as const, query: acquisition },
		{ requirement: 'technology' as const, query: technology },
		{ requirement: 'engagement' as const, query: engagement },
		{ requirement: 'revenue' as const, query: revenue },
		{ requirement: 'attribution' as const, query: attribution },
	];
	const active = reads.filter((read) => requirements.has(read.requirement) && enabled);
	const isLoading = active.some((read) => read.query.data === undefined && !read.query.error);
	const error = active.find((read) => read.query.error)?.query.error ?? null;
	const cubeData = cube.data;
	const cubeCells = Array.isArray(cubeData?.cells) ? cubeData.cells : [];
	const data =
		isLoading || error
			? undefined
			: ({
					summary: core.data?.summary ??
						summary.data?.summary ?? {
							pageviews: 0,
							visitors: 0,
							events: 0,
						},
					series: core.data?.series ?? [],
					top_paths: content.data?.top_paths ?? [],
					top_events: content.data?.top_events ?? [],
					top_referrers: acquisition.data?.top_referrers ?? [],
					top_countries: cubeBreakdown(cubeCells, {}, 'country'),
					top_devices: cubeBreakdown(cubeCells, {}, 'device'),
					channels: cubeBreakdown(cubeCells, {}, 'channel'),
					engagement: engagement.data?.engagement ?? EMPTY_ENGAGEMENT,
					top_browsers: technology.data?.top_browsers ?? [],
					top_os: technology.data?.top_os ?? [],
					top_screens: technology.data?.top_screens ?? [],
					top_languages: technology.data?.top_languages ?? [],
					top_regions: technology.data?.top_regions ?? [],
					top_networks: technology.data?.top_networks ?? [],
					top_connections: technology.data?.top_connections ?? [],
					revenue: attribution.data?.revenue ?? revenue.data?.revenue,
					revenue_by_channel:
						attribution.data?.revenue_by_channel ?? revenue.data?.revenue_by_channel,
					attribution: attribution.data?.attribution,
				} satisfies StatsResponse);

	return {
		data,
		cube: cubeData,
		isLoading,
		isFetching: active.some((read) => read.query.isFetching),
		isPlaceholderData: active.some((read) => read.query.isPlaceholderData),
		error,
		refetch: () => Promise.all(active.map((read) => read.query.refetch())),
	};
}
