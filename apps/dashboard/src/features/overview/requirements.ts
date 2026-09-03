import { type OverviewRequirement, TILE_CATALOG, type TileImplementationGroup } from './catalog.js';

export interface RequirementSlot {
	tileId: string;
}

/** Stable endpoint order keeps query setup and tests deterministic without string checks in consumers. */
export const OVERVIEW_REQUIREMENT_ORDER: readonly OverviewRequirement[] = [
	'core',
	'summary',
	'cube',
	'content',
	'acquisition',
	'technology',
	'engagement',
	'revenue',
	'attribution',
];

export type OverviewRequirements = ReadonlySet<OverviewRequirement>;

/** Union the typed contracts declared by every tile in a persisted layout. Attribution already returns
 * revenue, so it subsumes the smaller revenue request when both tiles are present. */
export function requirementsForLayout(slots: readonly RequirementSlot[]): OverviewRequirements {
	const requirements = new Set<OverviewRequirement>();
	for (const slot of slots) {
		for (const requirement of TILE_CATALOG[slot.tileId]?.requirements ?? []) {
			requirements.add(requirement);
		}
	}
	if (requirements.has('attribution')) requirements.delete('revenue');
	return requirements;
}

/** Union the independently declared preceding-period contracts. Current-only rendering data (for
 * example the flow cube or traffic series) never leaks into comparison reads. */
export function comparisonRequirements(slots: readonly RequirementSlot[]): OverviewRequirements {
	const comparison = new Set<OverviewRequirement>();
	for (const slot of slots) {
		for (const requirement of TILE_CATALOG[slot.tileId]?.comparisonRequirements ?? []) {
			comparison.add(requirement);
		}
	}
	if (comparison.has('attribution')) comparison.delete('revenue');
	return comparison;
}

export function activeImplementationGroups(
	slots: readonly RequirementSlot[],
): ReadonlySet<TileImplementationGroup> {
	const groups = new Set<TileImplementationGroup>();
	for (const slot of slots) {
		const group = TILE_CATALOG[slot.tileId]?.implementationGroup;
		if (group) groups.add(group);
	}
	return groups;
}

/** D1 statement count of each explicit Overview contract. Used in focused architecture tests and the
 * performance handoff; cube is two dependent statements (country bound + grouped cells). */
export const REQUIREMENT_STATEMENTS: Readonly<Record<OverviewRequirement, number>> = {
	core: 2,
	summary: 1,
	cube: 2,
	content: 2,
	acquisition: 1,
	technology: 7,
	engagement: 1,
	revenue: 2,
	attribution: 3,
};

export function statementCount(requirements: OverviewRequirements): number {
	let count = 0;
	for (const requirement of requirements) count += REQUIREMENT_STATEMENTS[requirement];
	return count;
}
