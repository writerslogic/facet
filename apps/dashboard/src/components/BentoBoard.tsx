// The bento board: renders the persisted slot layout as an elastic grid and hosts the three ways a user
// reshapes it — drag to reorder, Customize mode to resize/replace/remove/add tiles, and expand to focus a
// tile in place. Focusing inflates the grid tracks the tile spans and collapses the rest (see elasticGrid),
// so drill-down happens on one plane with no modal. Layout state comes from useBoardLayout (persisted per
// site); everything a tile draws comes from the shared TileContext computed by the caller.

import {
	Check,
	ChevronLeft,
	ChevronRight,
	GripVertical,
	Plus,
	RotateCcw,
	Settings2,
	Trash2,
} from 'lucide-react';
import { type ReactElement, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { readBoardLayout, useBoardLayout } from '../lib/boardLayout.js';
import { cn } from '../lib/cn.js';
import { packSlots, trackTemplate, useColumns, useElasticTracks } from '../lib/elasticGrid.js';
import {
	CHART_CYCLE,
	KPI_CYCLE,
	SIZE_LABEL,
	type SizeKey,
	type Slot,
	TILE_REGISTRY,
	type TileContext,
	newSlotUid,
} from '../lib/tiles.js';
import { BentoTile } from './BentoTile.js';

/** Step a slot to the next size in its kind's cycle (KPIs vs charts/lists have different cycles so a
 * tile only offers sizes that suit it). An off-cycle size snaps to the nearest cycle entry, so every
 * shipped default remains reversible rather than collapsing to the head. */
function nextSize(tileId: string, size: SizeKey): SizeKey {
	const cycle = TILE_REGISTRY[tileId]?.selfLabeled ? KPI_CYCLE : CHART_CYCLE;
	const i = cycle.indexOf(size);
	const from = i === -1 ? 0 : i;
	return cycle[(from + 1) % cycle.length] as SizeKey;
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
	const [focused, setFocused] = useState<string | null>(null);
	const [dragIndex, setDragIndex] = useState<number | null>(null);
	const [overIndex, setOverIndex] = useState<number | null>(null);
	const [adding, setAdding] = useState(false);
	// Announced to assistive tech after a keyboard move; the moved tile is re-focused by its uid.
	const [announce, setAnnounce] = useState('');
	const focusUid = useRef<string | null>(null);
	const restoreUid = useRef<string | null>(null);
	const tileRefs = useRef(new Map<string, HTMLDivElement>());
	const gridRef = useRef<HTMLDivElement>(null);
	const addWrapRef = useRef<HTMLDivElement>(null);
	const addToggleRef = useRef<HTMLButtonElement>(null);
	usePopoverDismiss(adding, () => setAdding(false), addWrapRef, addToggleRef);

	const cols = useColumns(gridRef);
	const { placements, rowCount } = useMemo(() => packSlots(slots, cols), [slots, cols]);
	// A stale focus (its tile was removed) resolves to no focus; the grid rests.
	const focusedIdx = focused ? slots.findIndex((s) => s.uid === focused) : -1;
	const activeFocus = focusedIdx >= 0 ? focused : null;
	const { colFr, rowFr } = useElasticTracks(
		cols,
		rowCount,
		focusedIdx >= 0 ? (placements[focusedIdx] ?? null) : null,
	);

	useEffect(() => {
		if (!focusUid.current) return;
		tileRefs.current.get(focusUid.current)?.focus();
		focusUid.current = null;
	});

	// Move keyboard focus with the expansion: onto the tile's Close on open, back to its Expand on close.
	useEffect(() => {
		if (activeFocus) {
			tileRefs.current
				.get(activeFocus)
				?.querySelector<HTMLElement>('[data-tile-close]')
				?.focus();
		} else if (restoreUid.current) {
			tileRefs.current
				.get(restoreUid.current)
				?.querySelector<HTMLElement>('[data-tile-expand]')
				?.focus();
			restoreUid.current = null;
		}
	}, [activeFocus]);

	// Escape collapses a focused tile (focus returns to its expand control via the effect above).
	useEffect(() => {
		if (!activeFocus) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') setFocused(null);
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [activeFocus]);

	const openFocus = (uid: string): void => {
		restoreUid.current = uid;
		setFocused(uid);
	};
	const startEditing = (): void => {
		setFocused(null);
		setEditing(true);
	};

	const move = (from: number, to: number): void => {
		if (to < 0 || to >= slots.length || from === to) return;
		const next = [...slots];
		const [moved] = next.splice(from, 1);
		if (!moved) return;
		next.splice(to, 0, moved);
		focusUid.current = moved.uid;
		setAnnounce(
			`Moved ${TILE_REGISTRY[moved.tileId]?.title ?? 'tile'} to position ${to + 1} of ${next.length}`,
		);
		setSlots(next);
	};
	const resize = (i: number): void =>
		setSlots(slots.map((s, j) => (j === i ? { ...s, size: nextSize(s.tileId, s.size) } : s)));
	const replace = (i: number, tileId: string): void =>
		setSlots(slots.map((s, j) => (j === i ? { ...s, tileId } : s)));
	const remove = (i: number): void => setSlots(slots.filter((_, j) => j !== i));
	const add = (tileId: string): void => {
		setSlots([
			...slots,
			{
				uid: newSlotUid(tileId),
				tileId,
				size: TILE_REGISTRY[tileId]?.size ?? 'md',
			},
		]);
		setAdding(false);
	};

	const present = new Set(slots.map((s) => s.tileId));

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex shrink-0 items-center justify-end gap-2">
				{editing ? (
					<>
						<div className="relative" ref={addWrapRef}>
							<button
								ref={addToggleRef}
								type="button"
								onClick={() => setAdding((v) => !v)}
								aria-haspopup="true"
								aria-expanded={adding}
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
											className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-neutral-600 text-sm transition hover:bg-neutral-100 hover:text-neutral-900"
										>
											{def.title}
											{present.has(def.id) ? (
												<Check
													className="h-3.5 w-3.5 text-accent-500"
													aria-label="on board"
												/>
											) : null}
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
						onClick={startEditing}
						className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 font-medium text-neutral-500 text-xs shadow-card transition hover:text-neutral-900"
					>
						<Settings2 className="h-3.5 w-3.5" aria-hidden="true" /> Customize
					</button>
				)}
			</div>

			<div
				ref={gridRef}
				// The grid always divides the available height into fr rows, so the board fills the viewport
				// exactly for ANY tile count — adding tiles shrinks every tile rather than spilling into a
				// scroll. Container queries (see BentoTile) keep the shrunk content legible.
				className="grid min-h-0 flex-1 gap-3 overflow-hidden"
				style={{
					gridTemplateColumns: trackTemplate(colFr),
					gridTemplateRows: trackTemplate(rowFr),
				}}
				role={editing ? 'list' : undefined}
				aria-label={editing ? 'Board tiles — use arrow keys to reorder' : undefined}
			>
				{slots.map((slot, i) => {
					const def = TILE_REGISTRY[slot.tileId];
					const p = placements[i];
					if (!def || !p) return null;
					const isFocused = slot.uid === activeFocus;
					const dim = activeFocus !== null && !isFocused;
					const isOver =
						editing && overIndex === i && dragIndex !== null && dragIndex !== i;
					return (
						<div
							key={slot.uid}
							ref={(el) => {
								if (el) tileRefs.current.set(slot.uid, el);
								else tileRefs.current.delete(slot.uid);
							}}
							role={editing ? 'listitem' : undefined}
							aria-label={
								editing
									? `${def.title}, position ${i + 1} of ${slots.length}. Use arrow keys to move.`
									: undefined
							}
							tabIndex={editing ? 0 : undefined}
							style={{
								gridColumn: `${p.colStart} / span ${p.colSpan}`,
								gridRow: `${p.rowStart} / span ${p.rowSpan}`,
							}}
							className={cn(
								'min-h-0 rounded-2xl transition-[opacity,filter] duration-300',
								isFocused && 'relative z-20',
								editing &&
									'cursor-grab focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
								dragIndex === i && 'opacity-40',
								isOver && 'ring-2 ring-accent-400 ring-offset-2',
								dim && 'pointer-events-none opacity-40',
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
							onKeyDown={(e) => {
								if (!editing) return;
								if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
									e.preventDefault();
									move(i, i - 1);
								} else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
									e.preventDefault();
									move(i, i + 1);
								}
							}}
						>
							<BentoTile
								label={def.selfLabeled ? undefined : def.title}
								emphasis={def.emphasis}
								focused={isFocused}
								action={
									editing ? (
										<TileControls
											slot={slot}
											title={def.title}
											canEarlier={i > 0}
											canLater={i < slots.length - 1}
											onMove={(dir) => move(i, i + dir)}
											onResize={() => resize(i)}
											onReplace={(id) => replace(i, id)}
											onRemove={() => remove(i)}
										/>
									) : (
										def.action?.(ctx)
									)
								}
								onExpand={
									!editing && def.expandable && activeFocus === null
										? () => openFocus(slot.uid)
										: undefined
								}
								onClose={isFocused ? () => setFocused(null) : undefined}
								className="h-full"
								bodyClassName={
									def.expandable || isFocused ? 'overflow-y-auto' : undefined
								}
							>
								{editing ? (
									<div className="pointer-events-none flex h-full items-center justify-center gap-2 text-neutral-400">
										<GripVertical className="h-5 w-5" aria-hidden="true" />
										<span className="font-medium text-neutral-500 text-xs uppercase tracking-wide">
											{def.title}
										</span>
									</div>
								) : (
									def.render(ctx, isFocused)
								)}
							</BentoTile>
						</div>
					);
				})}
			</div>

			{footer}

			<output className="sr-only" aria-live="polite">
				{announce}
			</output>
		</div>
	);
}

/** The per-tile edit controls shown in a tile's header while customizing: resize, replace, remove. All
 * controls carry accessible names naming the tile they act on; the replace popover is a managed menu. */
function TileControls({
	slot,
	title,
	canEarlier,
	canLater,
	onMove,
	onResize,
	onReplace,
	onRemove,
}: {
	slot: Slot;
	title: string;
	canEarlier: boolean;
	canLater: boolean;
	onMove: (dir: -1 | 1) => void;
	onResize: () => void;
	onReplace: (tileId: string) => void;
	onRemove: () => void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const toggleRef = useRef<HTMLButtonElement>(null);
	usePopoverDismiss(open, () => setOpen(false), wrapRef, toggleRef);
	return (
		<div className="pointer-events-auto flex items-center gap-1">
			<button
				type="button"
				onClick={() => onMove(-1)}
				disabled={!canEarlier}
				aria-label={`Move ${title} earlier`}
				className="rounded p-0.5 text-neutral-500 transition hover:text-neutral-900 disabled:opacity-30"
			>
				<ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
			<button
				type="button"
				onClick={() => onMove(1)}
				disabled={!canLater}
				aria-label={`Move ${title} later`}
				className="rounded p-0.5 text-neutral-500 transition hover:text-neutral-900 disabled:opacity-30"
			>
				<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
			<button
				type="button"
				onClick={onResize}
				aria-label={`Resize ${title}, currently ${SIZE_LABEL[slot.size]}`}
				className="rounded px-1.5 py-0.5 font-semibold text-[10px] text-neutral-500 uppercase ring-1 ring-neutral-200 transition hover:text-neutral-900"
			>
				{SIZE_LABEL[slot.size]}
			</button>
			<div className="relative" ref={wrapRef}>
				<button
					ref={toggleRef}
					type="button"
					onClick={() => setOpen((v) => !v)}
					aria-label={`Replace ${title}`}
					aria-haspopup="true"
					aria-expanded={open}
					className="rounded p-0.5 text-neutral-500 transition hover:text-neutral-900"
				>
					<Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
				</button>
				{open ? (
					<div className="absolute right-0 z-30 mt-1 max-h-64 w-48 overflow-y-auto rounded-xl border border-neutral-200/70 bg-white p-1 shadow-float ring-1 ring-neutral-900/5">
						{Object.values(TILE_REGISTRY).map((def) => (
							<button
								key={def.id}
								type="button"
								aria-current={def.id === slot.tileId}
								onClick={() => {
									onReplace(def.id);
									setOpen(false);
									toggleRef.current?.focus();
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
				aria-label={`Remove ${title}`}
				className="rounded p-0.5 text-neutral-500 transition hover:text-rose-600"
			>
				<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}

/** The loading state for the board: the exact same elastic-grid geometry (per-site persisted layout)
 * filled with shimmer placeholders, so the skeleton and the real board share one silhouette — no
 * re-layout flash when data lands. */
export function BentoSkeleton({ siteId }: { siteId: string }): ReactElement {
	const slots = readBoardLayout(siteId);
	const gridRef = useRef<HTMLDivElement>(null);
	const cols = useColumns(gridRef);
	const { placements, rowCount } = packSlots(slots, cols);
	return (
		<div
			ref={gridRef}
			className="grid min-h-0 flex-1 gap-3 overflow-hidden"
			style={{
				gridTemplateColumns: trackTemplate(new Array(cols).fill(1)),
				gridTemplateRows: trackTemplate(new Array(rowCount).fill(1)),
			}}
		>
			{placements.map((p, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder list with no identity
					key={i}
					style={{
						gridColumn: `${p.colStart} / span ${p.colSpan}`,
						gridRow: `${p.rowStart} / span ${p.rowSpan}`,
					}}
					className="animate-pulse rounded-2xl border border-neutral-200/70 bg-gradient-to-b from-white to-neutral-50/60 shadow-card ring-1 ring-neutral-900/5"
					aria-hidden="true"
				/>
			))}
		</div>
	);
}

/** Close a popover on Escape (returning focus to its toggle) or a pointer-down outside it. */
function usePopoverDismiss(
	open: boolean,
	close: () => void,
	wrapRef: RefObject<HTMLElement | null>,
	toggleRef: RefObject<HTMLElement | null>,
): void {
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') {
				close();
				toggleRef.current?.focus();
			}
		};
		const onDown = (e: PointerEvent): void => {
			if (!wrapRef.current?.contains(e.target as Node)) close();
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('pointerdown', onDown);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', onDown);
		};
	}, [open, close, wrapRef, toggleRef]);
}
