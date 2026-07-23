// The bento board: renders the persisted slot layout as a responsive grid and hosts the three ways a
// user reshapes it — drag to reorder, Customize mode to resize/replace/remove/add tiles, and expand to
// drill into a tile. Layout state comes from useBoardLayout (persisted per site); everything a tile
// draws comes from the shared TileContext computed by the caller.

import { GripVertical, Plus, RotateCcw, Settings2, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useBoardLayout } from '../lib/boardLayout.js';
import { cn } from '../lib/cn.js';
import {
	SIZES,
	SIZE_CYCLE,
	type SizeKey,
	type Slot,
	TILE_REGISTRY,
	type TileContext,
} from '../lib/tiles.js';
import { BentoTile } from './BentoTile.js';
import { TileOverlay } from './TileOverlay.js';

/** Advance a slot's size to the next step in the cycle (wraps). Sizes outside the cycle restart at its
 * head, so a default `short`/`wide` tile still resizes predictably. */
function nextSize(size: SizeKey): SizeKey {
	const i = SIZE_CYCLE.indexOf(size);
	return SIZE_CYCLE[(i + 1) % SIZE_CYCLE.length] as SizeKey;
}

export function BentoBoard({
	ctx,
	siteId,
	footer,
}: {
	ctx: TileContext;
	siteId: string;
	footer?: ReactElement | null;
}): ReactElement {
	const { slots, setSlots, reset } = useBoardLayout(siteId);
	const [editing, setEditing] = useState(false);
	const [overlay, setOverlay] = useState<string | null>(null);
	const [dragIndex, setDragIndex] = useState<number | null>(null);
	const [overIndex, setOverIndex] = useState<number | null>(null);
	const [adding, setAdding] = useState(false);

	const move = (from: number, to: number): void => {
		if (from === to) return;
		const next = [...slots];
		const [moved] = next.splice(from, 1);
		if (moved) next.splice(to, 0, moved);
		setSlots(next);
	};
	const resize = (i: number): void =>
		setSlots(slots.map((s, j) => (j === i ? { ...s, size: nextSize(s.size) } : s)));
	const replace = (i: number, tileId: string): void =>
		setSlots(slots.map((s, j) => (j === i ? { ...s, tileId } : s)));
	const remove = (i: number): void => setSlots(slots.filter((_, j) => j !== i));
	const add = (tileId: string): void => {
		setSlots([...slots, { tileId, size: TILE_REGISTRY[tileId]?.size ?? 'md' }]);
		setAdding(false);
	};

	const overlayDef = overlay ? TILE_REGISTRY[overlay] : null;

	return (
		<div className="flex min-h-0 flex-col gap-3 lg:h-[calc(100dvh-13rem)]">
			<div className="flex shrink-0 items-center justify-end gap-2">
				{editing ? (
					<>
						<div className="relative">
							<button
								type="button"
								onClick={() => setAdding((v) => !v)}
								className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 font-medium text-neutral-600 text-xs shadow-card transition hover:text-neutral-900"
							>
								<Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add tile
							</button>
							{adding ? (
								<div className="absolute right-0 z-30 mt-1 max-h-72 w-52 overflow-y-auto rounded-xl border border-neutral-200/70 bg-white p-1 shadow-float ring-1 ring-neutral-900/5">
									{Object.values(TILE_REGISTRY).map((def) => (
										<button
											key={def.id}
											type="button"
											onClick={() => add(def.id)}
											className="block w-full rounded-md px-2.5 py-1.5 text-left text-neutral-600 text-sm transition hover:bg-neutral-100 hover:text-neutral-900"
										>
											{def.title}
										</button>
									))}
								</div>
							) : null}
						</div>
						<button
							type="button"
							onClick={reset}
							className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 font-medium text-neutral-600 text-xs shadow-card transition hover:text-neutral-900"
						>
							<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset
						</button>
						<button
							type="button"
							onClick={() => {
								setEditing(false);
								setAdding(false);
							}}
							className="inline-flex items-center rounded-lg bg-accent-600 px-3 py-1.5 font-medium text-white text-xs shadow-card transition hover:bg-accent-700"
						>
							Done
						</button>
					</>
				) : (
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 font-medium text-neutral-500 text-xs shadow-card transition hover:text-neutral-900"
					>
						<Settings2 className="h-3.5 w-3.5" aria-hidden="true" /> Customize
					</button>
				)}
			</div>

			<div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-2 gap-3 lg:grid-cols-6 lg:grid-rows-6">
				{slots.map((slot, i) => {
					const def = TILE_REGISTRY[slot.tileId];
					if (!def) return null;
					const isOver =
						editing && overIndex === i && dragIndex !== null && dragIndex !== i;
					return (
						<div
							key={`${slot.tileId}-${i}`}
							className={cn(
								SIZES[slot.size],
								'min-h-0',
								editing && 'cursor-grab',
								dragIndex === i && 'opacity-40',
								isOver && 'ring-2 ring-accent-400 ring-offset-2',
								'rounded-2xl transition',
							)}
							draggable={editing}
							onDragStart={() => setDragIndex(i)}
							onDragEnd={() => {
								setDragIndex(null);
								setOverIndex(null);
							}}
							onDragOver={(e) => {
								if (!editing) return;
								e.preventDefault();
								setOverIndex(i);
							}}
							onDrop={(e) => {
								e.preventDefault();
								if (dragIndex !== null) move(dragIndex, i);
								setDragIndex(null);
								setOverIndex(null);
							}}
						>
							<BentoTile
								label={def.selfLabeled ? undefined : def.title}
								action={
									editing ? (
										<TileControls
											slot={slot}
											onResize={() => resize(i)}
											onReplace={(id) => replace(i, id)}
											onRemove={() => remove(i)}
										/>
									) : (
										def.action?.(ctx)
									)
								}
								onExpand={
									!editing && def.expandable
										? () => setOverlay(def.id)
										: undefined
								}
								className="h-full"
								bodyClassName={def.expandable ? 'overflow-y-auto' : undefined}
							>
								{editing ? (
									<div className="pointer-events-none flex h-full items-center justify-center gap-2 text-neutral-300">
										<GripVertical className="h-5 w-5" aria-hidden="true" />
										<span className="font-medium text-neutral-400 text-xs uppercase tracking-wide">
											{def.title}
										</span>
									</div>
								) : (
									def.render(ctx)
								)}
							</BentoTile>
						</div>
					);
				})}
			</div>

			{footer}

			{overlayDef ? (
				<TileOverlay tile={overlayDef} ctx={ctx} onClose={() => setOverlay(null)} />
			) : null}
		</div>
	);
}

/** The per-tile edit controls shown in a tile's header while customizing: resize, replace, remove. */
function TileControls({
	slot,
	onResize,
	onReplace,
	onRemove,
}: {
	slot: Slot;
	onResize: () => void;
	onReplace: (tileId: string) => void;
	onRemove: () => void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	return (
		<div className="pointer-events-auto flex items-center gap-1">
			<button
				type="button"
				onClick={onResize}
				title="Resize"
				className="rounded px-1.5 py-0.5 font-semibold text-[10px] text-neutral-500 uppercase ring-1 ring-neutral-200 transition hover:text-neutral-900"
			>
				{slot.size}
			</button>
			<div className="relative">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					title="Replace tile"
					className="rounded p-0.5 text-neutral-400 transition hover:text-neutral-900"
				>
					<Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
				</button>
				{open ? (
					<div className="absolute right-0 z-30 mt-1 max-h-64 w-48 overflow-y-auto rounded-xl border border-neutral-200/70 bg-white p-1 shadow-float ring-1 ring-neutral-900/5">
						{Object.values(TILE_REGISTRY).map((def) => (
							<button
								key={def.id}
								type="button"
								onClick={() => {
									onReplace(def.id);
									setOpen(false);
								}}
								className={cn(
									'block w-full rounded-md px-2.5 py-1.5 text-left text-sm transition hover:bg-neutral-100',
									def.id === slot.tileId
										? 'font-semibold text-accent-700'
										: 'text-neutral-600 hover:text-neutral-900',
								)}
							>
								{def.title}
							</button>
						))}
					</div>
				) : null}
			</div>
			<button
				type="button"
				onClick={onRemove}
				title="Remove tile"
				className="rounded p-0.5 text-neutral-400 transition hover:text-rose-600"
			>
				<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}
