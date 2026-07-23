// The drill-down overlay. Expanding a tile mounts it here at full size with `expanded` set, so lists
// show more rows and charts breathe. Cross-filter controls inside the tile stay live, so you can slice
// from within the overlay. Closes on Escape or backdrop click; restores focus to the trigger on unmount.

import { X } from 'lucide-react';
import { type ReactElement, useEffect, useRef } from 'react';
import type { TileContext, TileDef } from '../lib/tiles.js';

export function TileOverlay({
	tile,
	ctx,
	onClose,
}: {
	tile: TileDef;
	ctx: TileContext;
	onClose: () => void;
}): ReactElement {
	const closeRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const prev = document.activeElement as HTMLElement | null;
		closeRef.current?.focus();
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') onClose();
		};
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('keydown', onKey);
			prev?.focus?.();
		};
	}, [onClose]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: a real <dialog> would need imperative showModal(); this overlay is controlled by React state
		<div
			role="dialog"
			aria-modal="true"
			aria-label={`${tile.title} detail`}
			className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
		>
			<button
				type="button"
				aria-label="Close detail"
				onClick={onClose}
				className="absolute inset-0 h-full w-full cursor-default bg-neutral-950/40 backdrop-blur-sm"
			/>
			<div className="relative flex h-full max-h-[860px] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-neutral-200/70 bg-white shadow-float ring-1 ring-neutral-900/5">
				<header className="flex shrink-0 items-center justify-between border-neutral-100 border-b px-5 py-3.5">
					<h2 className="font-semibold text-[13px] text-neutral-500 uppercase tracking-[0.08em]">
						{tile.title}
					</h2>
					<button
						ref={closeRef}
						type="button"
						onClick={onClose}
						aria-label="Close detail"
						className="rounded-md p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto p-5">{tile.render(ctx, true)}</div>
			</div>
		</div>
	);
}
