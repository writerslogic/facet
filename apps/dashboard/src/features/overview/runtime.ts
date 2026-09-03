import { useEffect, useState } from 'react';
import type { TileDef } from '../../components/boxes/types.js';
import { CORE_TILES } from './boxes/core.js';
import type { TileImplementationGroup } from './catalog.js';

type TileMap = Readonly<Record<string, TileDef>>;

let advancedPromise: Promise<TileMap> | null = null;
let attributionPromise: Promise<TileMap> | null = null;
let advancedTiles: TileMap | null = null;
let attributionTiles: TileMap | null = null;

/** Explicit dynamic boundaries. Shared promises make layout preloading and per-tile rendering use the
 * same network request, including when several optional tiles mount together. */
export function loadTileGroup(group: TileImplementationGroup): Promise<TileMap> {
	if (group === 'core') return Promise.resolve(CORE_TILES);
	if (group === 'advanced') {
		advancedPromise ??= import('./boxes/advanced.js').then((module) => {
			advancedTiles = module.ADVANCED_TILES;
			return advancedTiles;
		});
		return advancedPromise;
	}
	attributionPromise ??= import('./boxes/attribution.js').then((module) => {
		attributionTiles = module.ATTRIBUTION_TILES;
		return attributionTiles;
	});
	return attributionPromise;
}

function loadedTile(tileId: string, group: TileImplementationGroup): TileDef | undefined {
	if (group === 'core') return CORE_TILES[tileId];
	return (group === 'advanced' ? advancedTiles : attributionTiles)?.[tileId];
}

export function useTileImplementation(
	tileId: string,
	group: TileImplementationGroup,
): { implementation: TileDef | undefined; error: Error | null } {
	const [implementation, setImplementation] = useState<TileDef | undefined>(() =>
		loadedTile(tileId, group),
	);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		const loaded = loadedTile(tileId, group);
		if (loaded) {
			setImplementation(loaded);
			setError(null);
			return;
		}
		let active = true;
		void loadTileGroup(group).then(
			(tiles) => {
				if (!active) return;
				setImplementation(tiles[tileId]);
				setError(null);
			},
			(cause: unknown) => {
				if (!active) return;
				setError(cause instanceof Error ? cause : new Error('tile_chunk_failed'));
			},
		);
		return () => {
			active = false;
		};
	}, [group, tileId]);

	return { implementation, error };
}
