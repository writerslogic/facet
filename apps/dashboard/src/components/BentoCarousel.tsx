// Small-viewport fallback for the bento board: instead of squeezing the elastic grid into a phone width,
// each box becomes full-size and the user swipes (or taps the arrows / dots) left-right through them.
// Native horizontal scroll-snap does the sliding; the arrows/dots drive it and track the current box.

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactElement, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { type Slot, TILE_REGISTRY, type TileContext, resolveTileConfig } from '../lib/tiles.js';
import { BentoTile } from './BentoTile.js';

export function BentoCarousel({
	slots,
	ctx,
}: {
	slots: Slot[];
	ctx: TileContext;
}): ReactElement {
	const trackRef = useRef<HTMLDivElement>(null);
	const [index, setIndex] = useState(0);

	const go = (i: number): void => {
		const track = trackRef.current;
		if (!track) return;
		const clamped = Math.max(0, Math.min(slots.length - 1, i));
		track.scrollTo({
			left: clamped * track.clientWidth,
			behavior: 'smooth',
		});
		setIndex(clamped);
	};
	const onScroll = (): void => {
		const track = trackRef.current;
		if (!track || track.clientWidth === 0) return;
		setIndex(Math.round(track.scrollLeft / track.clientWidth));
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<div
				ref={trackRef}
				onScroll={onScroll}
				className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				{slots.map((slot) => {
					const def = TILE_REGISTRY[slot.tileId];
					if (!def) return null;
					return (
						<div key={slot.uid} className="h-full w-full shrink-0 snap-center">
							<BentoTile
								label={def.selfLabeled ? undefined : def.title}
								emphasis={def.emphasis}
								action={def.action?.(ctx)}
								className="h-full"
								bodyClassName="overflow-y-auto"
							>
								{def.render(ctx, 'expanded', resolveTileConfig(def, slot.config))}
							</BentoTile>
						</div>
					);
				})}
			</div>
			<div className="flex shrink-0 items-center justify-center gap-3 py-1">
				<button
					type="button"
					onClick={() => go(index - 1)}
					disabled={index === 0}
					aria-label="Previous box"
					className="rounded-full border border-[color:rgb(var(--border))] p-1.5 text-[color:var(--muted)] transition hover:text-[color:var(--ink)] disabled:opacity-30"
				>
					<ChevronLeft className="h-4 w-4" aria-hidden="true" />
				</button>
				<div className="flex items-center gap-1.5">
					{slots.map((slot, i) => (
						<button
							key={slot.uid}
							type="button"
							onClick={() => go(i)}
							aria-label={`Go to ${TILE_REGISTRY[slot.tileId]?.title ?? 'box'}`}
							aria-current={i === index}
							className={cn(
								'h-1.5 rounded-full transition-all',
								i === index
									? 'w-4 bg-accent-400'
									: 'w-1.5 bg-[color:rgb(var(--border))] hover:bg-[color:var(--faint)]',
							)}
						/>
					))}
				</div>
				<button
					type="button"
					onClick={() => go(index + 1)}
					disabled={index === slots.length - 1}
					aria-label="Next box"
					className="rounded-full border border-[color:rgb(var(--border))] p-1.5 text-[color:var(--muted)] transition hover:text-[color:var(--ink)] disabled:opacity-30"
				>
					<ChevronRight className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}
