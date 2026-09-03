// Overview tile metadata. This module is deliberately JSX-free: persisted layouts, settings, query
// planning, and loading shells can inspect the complete catalog without importing optional charts.

export type SizeKey = 'kpi' | 'sm' | 'md' | 'lg' | 'wide' | 'tall' | 'xl' | 'short';
export type TileEmphasis = 'hero' | 'flow' | 'kpi' | 'default';
export type TileImplementationGroup = 'core' | 'advanced' | 'attribution';

export type OverviewRequirement =
	| 'core'
	| 'summary'
	| 'cube'
	| 'content'
	| 'acquisition'
	| 'technology'
	| 'engagement'
	| 'revenue'
	| 'attribution';

export type TileConfigValue = string | boolean;
export interface TileConfig {
	variant?: string;
	[key: string]: TileConfigValue | undefined;
}

export interface TileVariant {
	id: string;
	label: string;
}

export interface TileOption {
	key: string;
	label: string;
	type: 'select' | 'toggle' | 'color';
	choices?: { value: string; label: string }[];
	default: TileConfigValue;
}

export interface TileMetadata {
	id: string;
	title: string;
	size: SizeKey;
	requirements: readonly OverviewRequirement[];
	comparisonRequirements?: readonly OverviewRequirement[];
	implementationGroup: TileImplementationGroup;
	expandable?: boolean;
	hasTable?: boolean;
	selfLabeled?: boolean;
	emphasis?: TileEmphasis;
	variants?: readonly TileVariant[];
	options?: readonly TileOption[];
}

const ACCENT_OPTION: TileOption = {
	key: 'accent',
	label: 'Color',
	type: 'color',
	choices: [
		{ value: 'auto', label: 'Auto (prism)' },
		{ value: 'var(--d1)', label: 'Indigo' },
		{ value: 'var(--d2)', label: 'Violet' },
		{ value: 'var(--d3)', label: 'Fuchsia' },
		{ value: 'var(--c4)', label: 'Cyan' },
		{ value: 'var(--c5)', label: 'Amber' },
		{ value: 'var(--pos)', label: 'Green' },
	],
	default: 'auto',
};

const LIST_VARIANTS: readonly TileVariant[] = [
	{ id: 'bars', label: 'Bars' },
	{ id: 'donut', label: 'Donut' },
	{ id: 'table', label: 'Table' },
];

const LIST_OPTIONS: readonly TileOption[] = [
	{
		key: 'rows',
		label: 'Rows',
		type: 'select',
		choices: [
			{ value: 'auto', label: 'Auto' },
			{ value: '5', label: 'Top 5' },
			{ value: '8', label: 'Top 8' },
			{ value: '12', label: 'Top 12' },
		],
		default: 'auto',
	},
	ACCENT_OPTION,
];

const KPI = (variants: readonly TileVariant[]): Pick<TileMetadata, 'variants' | 'options'> => ({
	variants,
	options: [ACCENT_OPTION],
});

const LIST = { variants: LIST_VARIANTS, options: LIST_OPTIONS } as const;
const CORE = 'core' as const;
const ADVANCED = 'advanced' as const;
const ATTRIBUTION = 'attribution' as const;

const tiles: readonly TileMetadata[] = [
	{
		id: 'traffic',
		title: 'Traffic over time',
		size: 'xl',
		requirements: ['core'],
		comparisonRequirements: ['summary'],
		implementationGroup: CORE,
		emphasis: 'hero',
		expandable: true,
		hasTable: true,
		variants: [
			{ id: 'area', label: 'Area' },
			{ id: 'line', label: 'Line' },
			{ id: 'bars', label: 'Bars' },
			{ id: 'smooth', label: 'Smooth' },
		],
		options: [
			{
				key: 'scale',
				label: 'Scale',
				type: 'select',
				choices: [
					{ value: 'linear', label: 'Linear' },
					{ value: 'log', label: 'Log' },
				],
				default: 'linear',
			},
			{ key: 'trend', label: 'Trend line', type: 'toggle', default: false },
			ACCENT_OPTION,
		],
	},
	{
		id: 'pageviews',
		title: 'Pageviews',
		size: 'kpi',
		requirements: ['core', 'content'],
		comparisonRequirements: ['summary', 'content'],
		implementationGroup: CORE,
		selfLabeled: true,
		emphasis: 'kpi',
		expandable: true,
		hasTable: true,
		...KPI([
			{ id: 'horizon', label: 'Horizon' },
			{ id: 'spark', label: 'Line' },
			{ id: 'columns', label: 'Columns' },
		]),
	},
	{
		id: 'visitors',
		title: 'Visitors',
		size: 'kpi',
		requirements: ['core', 'cube'],
		comparisonRequirements: ['summary', 'cube'],
		implementationGroup: CORE,
		selfLabeled: true,
		emphasis: 'kpi',
		expandable: true,
		hasTable: true,
		...KPI([
			{ id: 'gauge', label: 'Gauge' },
			{ id: 'spark', label: 'Line' },
			{ id: 'horizon', label: 'Horizon' },
			{ id: 'columns', label: 'Columns' },
		]),
	},
	{
		id: 'events',
		title: 'Events',
		size: 'kpi',
		requirements: ['core', 'cube', 'content'],
		comparisonRequirements: ['summary', 'content'],
		implementationGroup: CORE,
		selfLabeled: true,
		emphasis: 'kpi',
		expandable: true,
		hasTable: true,
		...KPI([
			{ id: 'columns', label: 'Columns' },
			{ id: 'spark', label: 'Line' },
			{ id: 'horizon', label: 'Horizon' },
		]),
	},
	{
		id: 'pages',
		title: 'Top pages',
		size: 'lg',
		requirements: ['content'],
		comparisonRequirements: ['content'],
		implementationGroup: CORE,
		expandable: true,
		hasTable: true,
		...LIST,
	},
	{
		id: 'countries',
		title: 'Countries',
		size: 'lg',
		requirements: ['core', 'cube'],
		comparisonRequirements: ['cube'],
		implementationGroup: CORE,
		expandable: true,
		hasTable: true,
		variants: [{ id: 'map', label: 'Map' }, ...LIST_VARIANTS],
		options: LIST_OPTIONS,
	},
	{
		id: 'flow',
		title: 'Traffic flow',
		size: 'tall',
		requirements: ['cube'],
		implementationGroup: ADVANCED,
		emphasis: 'flow',
		expandable: true,
		hasTable: true,
	},
	{
		id: 'segments',
		title: 'Segments',
		size: 'tall',
		requirements: ['core', 'cube'],
		implementationGroup: ADVANCED,
		expandable: true,
		hasTable: true,
		options: [
			{
				key: 'axis',
				label: 'Dimension',
				type: 'select',
				choices: [
					{ value: 'channel', label: 'Channel' },
					{ value: 'device', label: 'Device' },
					{ value: 'country', label: 'Country' },
				],
				default: 'channel',
			},
		],
	},
	{
		id: 'trends',
		title: 'Trends by dimension',
		size: 'wide',
		requirements: [],
		implementationGroup: ADVANCED,
		expandable: true,
		variants: [
			{ id: 'focus', label: 'Focus lines' },
			{ id: 'brush', label: 'Brush + zoom' },
		],
		options: [
			{
				key: 'dimension',
				label: 'Split by',
				type: 'select',
				choices: ['path', 'referrer', 'country', 'device', 'channel'].map((value) => ({
					value,
					label: value[0]?.toUpperCase() + value.slice(1),
				})),
				default: 'path',
			},
			{
				key: 'metric',
				label: 'Metric',
				type: 'select',
				choices: [
					{ value: 'pageviews', label: 'Pageviews' },
					{ value: 'events', label: 'Events' },
				],
				default: 'pageviews',
			},
			{
				key: 'lines',
				label: 'Lines',
				type: 'select',
				choices: ['3', '5', '8'].map((value) => ({ value, label: `Top ${value}` })),
				default: '5',
			},
		],
	},
	{
		id: 'path-tree',
		title: 'Path explorer',
		size: 'tall',
		requirements: [],
		implementationGroup: ADVANCED,
		expandable: true,
		variants: [
			{ id: 'sunburst', label: 'Sunburst' },
			{ id: 'treemap', label: 'Treemap' },
		],
		options: [
			{
				key: 'levels',
				label: 'Levels',
				type: 'select',
				choices: ['auto', '2', '3', '4'].map((value) => ({
					value,
					label: value === 'auto' ? 'Auto' : value,
				})),
				default: 'auto',
			},
		],
	},
	{
		id: 'timing',
		title: 'When traffic arrives',
		size: 'tall',
		requirements: ['core'],
		implementationGroup: ADVANCED,
		expandable: true,
		hasTable: true,
		variants: [
			{ id: 'polar', label: 'Polar grid' },
			{ id: 'nightingale', label: 'Nightingale' },
			{ id: 'calendar', label: 'Calendar' },
		],
		options: [
			{
				key: 'timezone',
				label: 'Hours',
				type: 'select',
				choices: [
					{ value: 'utc', label: 'UTC (as served)' },
					{ value: 'local', label: 'Your local offset' },
				],
				default: 'utc',
			},
		],
	},
	{
		id: 'distribution',
		title: 'Session distribution',
		size: 'lg',
		requirements: [],
		implementationGroup: ADVANCED,
		expandable: true,
		variants: [
			{ id: 'duration', label: 'Duration' },
			{ id: 'pageviews', label: 'Pages per session' },
		],
	},
	{
		id: 'referrers',
		title: 'Referrers',
		size: 'lg',
		requirements: ['core', 'acquisition'],
		comparisonRequirements: ['acquisition'],
		implementationGroup: ADVANCED,
		expandable: true,
		hasTable: true,
		...LIST,
	},
	...[
		['devices', 'Devices'],
		['channels', 'Channels'],
	].map(
		([id, title]): TileMetadata => ({
			id: id as string,
			title: title as string,
			size: 'lg',
			requirements: ['cube'],
			comparisonRequirements: ['cube'],
			implementationGroup: ADVANCED,
			expandable: true,
			hasTable: true,
			...LIST,
		}),
	),
	{
		id: 'events_list',
		title: 'Top events',
		size: 'lg',
		requirements: ['content'],
		comparisonRequirements: ['content'],
		implementationGroup: ADVANCED,
		expandable: true,
		hasTable: true,
		...LIST,
	},
	{
		id: 'engagement',
		title: 'Engagement',
		size: 'md',
		requirements: ['engagement'],
		comparisonRequirements: ['engagement'],
		implementationGroup: ADVANCED,
		expandable: true,
		hasTable: true,
	},
	...[
		['browsers', 'Browsers'],
		['os', 'Operating systems'],
		['screens', 'Screen size'],
		['languages', 'Languages'],
		['regions', 'Regions'],
		['networks', 'Networks'],
		['connection', 'Connection'],
	].map(
		([id, title]): TileMetadata => ({
			id: id as string,
			title: title as string,
			size: 'lg',
			requirements: ['technology'],
			comparisonRequirements: ['technology'],
			implementationGroup: ADVANCED,
			expandable: true,
			hasTable: true,
			...LIST,
		}),
	),
	{
		id: 'revenue',
		title: 'Revenue',
		size: 'md',
		requirements: ['revenue', 'cube'],
		comparisonRequirements: ['revenue'],
		implementationGroup: ATTRIBUTION,
		selfLabeled: true,
		emphasis: 'kpi',
		expandable: true,
		hasTable: true,
	},
	{
		id: 'attribution',
		title: 'Attribution',
		size: 'lg',
		requirements: ['attribution', 'cube'],
		comparisonRequirements: ['attribution'],
		implementationGroup: ATTRIBUTION,
		expandable: true,
		hasTable: true,
		variants: [
			{ id: 'last', label: 'Last touch' },
			{ id: 'first', label: 'First touch' },
			{ id: 'linear', label: 'Linear' },
			{ id: 'position', label: 'Position' },
			{ id: 'time_decay', label: 'Time decay' },
			{ id: 'markov', label: 'Markov' },
		],
		options: LIST_OPTIONS,
	},
];

export const TILE_CATALOG: Readonly<Record<string, TileMetadata>> = Object.fromEntries(
	tiles.map((tile) => [tile.id, tile]),
);

export const TILE_CATALOG_LIST: readonly TileMetadata[] = tiles;
