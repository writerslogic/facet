// Phone layout for the Overview. Headline metrics form one comparable strip; every visualization then
// gets a stable vertical card. This keeps the board's reading order visible and avoids a many-slide
// carousel whose position, tiny dots, and horizontal scroll competed with the page.

import type { ReactElement } from 'react';
import { useTileImplementation } from '../features/overview/runtime.js';
import { type Slot, TILE_REGISTRY, type TileContext, resolveTileConfig } from '../lib/tiles.js';
import { BentoTile } from './BentoTile.js';

function MobileTile({
	slot,
	ctx,
	metric = false,
}: { slot: Slot; ctx: TileContext; metric?: boolean }) {
	const def = TILE_REGISTRY[slot.tileId];
	const { implementation, error } = useTileImplementation(
		slot.tileId,
		def?.implementationGroup ?? 'core',
	);
	if (!def) return null;
	return (
		<BentoTile
			title={def.title}
			label={def.selfLabeled ? undefined : def.title}
			emphasis={def.emphasis}
			action={metric ? undefined : implementation?.action?.(ctx)}
			className={metric ? 'h-32' : 'min-h-[20rem]'}
		>
			{implementation ? (
				implementation.render(ctx, 'default', resolveTileConfig(def, slot.config))
			) : error ? (
				<p role="alert" className="text-[color:var(--muted)] text-xs">
					Could not load this tile.
				</p>
			) : (
				<div
					className="h-full animate-pulse rounded-xl bg-[color:rgb(var(--hover))]"
					aria-hidden="true"
				/>
			)}
		</BentoTile>
	);
}

export function BentoMobileFeed({
	slots,
	ctx,
}: {
	slots: Slot[];
	ctx: TileContext;
}): ReactElement {
	const metrics = slots.filter((slot) => slot.size === 'kpi');
	const insights = slots.filter((slot) => slot.size !== 'kpi');

	return (
		<div
			className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
			aria-label="Overview feed"
		>
			<div className="space-y-3 pb-2">
				{metrics.length > 0 ? (
					<section className="grid grid-cols-3 gap-2" aria-label="Key metrics">
						{metrics.map((slot) => (
							<MobileTile key={slot.uid} slot={slot} ctx={ctx} metric />
						))}
					</section>
				) : null}
				{insights.map((slot) => (
					<MobileTile key={slot.uid} slot={slot} ctx={ctx} />
				))}
			</div>
		</div>
	);
}
