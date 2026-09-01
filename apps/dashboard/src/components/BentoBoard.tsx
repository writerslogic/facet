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
import { type CSSProperties, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { readBoardLayout, useBoardLayout, useBoardPrefs } from '../lib/boardLayout.js';
import { cn } from '../lib/cn.js';
import {
	type Placement,
	ROW_FLOOR,
	maxFitRows,
	packSlots,
	rowMinimums,
	trackTemplate,
	useBoardHeight,
	useColumns,
	useElasticTracks,
	useNarrow,
	useTileDensity,
} from '../lib/elasticGrid.js';
import {
	CHART_CYCLE,
	KPI_CYCLE,
	SIZE_LABEL,
	type SizeKey,
	type Slot,
	TILE_REGISTRY,
	type TileConfig,
	type TileContext,
	type TileDef,
	newSlotUid,
	resolveTileConfig,
} from '../lib/tiles.js';
import { usePopoverDismiss } from '../lib/usePopoverDismiss.js';
import { BentoCarousel } from './BentoCarousel.js';
import { BentoTile } from './BentoTile.js';
import { DataTable } from './DataTable.js';
import { LivePill } from './LivePill.js';

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
	editing,
	onEditingChange,
}: {
	ctx: TileContext;
	siteId: string;
	footer?: ReactElement | null;
	/** Layout-editing mode. Owned by App and entered from Settings → Overview board → Edit layout, so
	 * the board no longer carries its own Customize control. */
	editing: boolean;
	onEditingChange: (next: boolean) => void;
}): ReactElement {
	const { slots, setSlots, reset } = useBoardLayout(siteId);
	const { prefs } = useBoardPrefs(siteId);
	const [focused, setFocused] = useState<string | null>(null);
	// The slot currently showing its raw-data table (via the box's `table` toggle), if any.
	const [tableUid, setTableUid] = useState<string | null>(null);
	const [dragIndex, setDragIndex] = useState<number | null>(null);
	const [overIndex, setOverIndex] = useState<number | null>(null);
	const [adding, setAdding] = useState(false);
	// Announced to assistive tech after a keyboard move; the moved tile is re-focused by its uid.
	const [announce, setAnnounce] = useState('');
	const focusUid = useRef<string | null>(null);
	const restoreUid = useRef<string | null>(null);
	const tileRefs = useRef(new Map<string, HTMLDivElement>());
	const gridRef = useRef<HTMLDivElement>(null);
	const boardRef = useRef<HTMLDivElement>(null);
	const narrow = useNarrow(boardRef);
	const addWrapRef = useRef<HTMLDivElement>(null);
	const addToggleRef = useRef<HTMLButtonElement>(null);
	usePopoverDismiss(adding, () => setAdding(false), addWrapRef, addToggleRef);

	const cols = useColumns(gridRef);
	const boardHeight = useBoardHeight(gridRef);
	const { placements, rowCount: packedRows } = useMemo(
		() => packSlots(slots, cols),
		[slots, cols],
	);

	// Fit mode (the default) is a promise that the board never scrolls, and the only honest way to keep
	// it as tiles are added is to show fewer tiles rather than shorter ones — under about 56px a tile has
	// no rendering left, not even its compact one. Tiles past the cap are withheld and counted, never
	// silently dropped.
	const rowCap = prefs.scroll ? Number.POSITIVE_INFINITY : maxFitRows(boardHeight);
	const visibleCount = useMemo(
		() =>
			placements.reduce(
				(n, p, i) => (p.rowStart + p.rowSpan - 1 <= rowCap ? Math.max(n, i + 1) : n),
				0,
			),
		[placements, rowCap],
	);
	const visible = prefs.scroll ? slots : slots.slice(0, visibleCount);
	const withheld = slots.length - visible.length;
	const rowCount = prefs.scroll ? packedRows : Math.min(packedRows, rowCap);

	// A stale focus (its tile was removed, or fit mode withheld it) resolves to no focus; the grid rests.
	const focusedIdx = focused ? visible.findIndex((s) => s.uid === focused) : -1;
	const activeFocus = focusedIdx >= 0 ? focused : null;
	const focusPlacement = focusedIdx >= 0 ? (placements[focusedIdx] ?? null) : null;
	const { colFr, rowFr } = useElasticTracks(cols, rowCount, focusPlacement);
	// Per-track, not one global floor: see rowMinimums. In fit mode there are no floors at all, because
	// a floor is what would force a scrollbar the user turned off.
	const rowMins = prefs.scroll ? rowMinimums(rowCount, focusPlacement) : '0';

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
		// Replacing the box clears its config — the old chart style/options may not fit the new box.
		setSlots(slots.map((s, j) => (j === i ? { ...s, tileId, config: undefined } : s)));
	const setConfig = (i: number, patch: TileConfig): void =>
		setSlots(slots.map((s, j) => (j === i ? { ...s, config: { ...s.config, ...patch } } : s)));
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
		<div ref={boardRef} className="flex min-h-0 flex-1 flex-col gap-3">
			{narrow && !editing ? (
				<BentoCarousel slots={slots} ctx={ctx} />
			) : (
				<>
					<div className="flex shrink-0 items-center justify-end gap-2">
						{editing ? null : <LivePill />}
						{editing ? (
							<>
								<div className="relative" ref={addWrapRef}>
									<button
										ref={addToggleRef}
										type="button"
										onClick={() => setAdding((v) => !v)}
										aria-haspopup="true"
										aria-expanded={adding}
										className="inline-flex items-center gap-1.5 rounded-lg border border-[color:rgb(var(--border))] bg-[var(--panel)] px-2.5 py-1.5 font-medium text-[color:var(--ink)] text-xs shadow-card transition hover:text-[color:var(--ink)]"
									>
										<Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add tile
									</button>
									{adding ? (
										<div className="absolute right-0 z-30 mt-1 max-h-72 w-52 overflow-y-auto rounded-xl border border-[color:rgb(var(--border))] bg-[var(--panel)] p-1 shadow-float ring-1 ring-[color:rgb(var(--border))]">
											{Object.values(TILE_REGISTRY).map((def) => (
												<button
													key={def.id}
													type="button"
													onClick={() => add(def.id)}
													className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[color:var(--ink)] text-sm transition hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
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
									className="inline-flex items-center gap-1.5 rounded-lg border border-[color:rgb(var(--border))] bg-[var(--panel)] px-2.5 py-1.5 font-medium text-[color:var(--ink)] text-xs shadow-card transition hover:text-[color:var(--ink)]"
								>
									<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset
								</button>
								<button
									type="button"
									onClick={() => {
										onEditingChange(false);
										setAdding(false);
									}}
									className="inline-flex items-center rounded-lg btn-accent px-3 py-1.5 text-xs shadow-card transition"
								>
									Done
								</button>
							</>
						) : withheld > 0 ? (
							<p className="text-[color:var(--faint)] text-xs">
								{withheld} more {withheld === 1 ? 'tile' : 'tiles'} hidden to fit
								the window. Turn on board scrolling in Settings to show them.
							</p>
						) : null}
					</div>

					<div
						ref={gridRef}
						// Rows divide the viewport as fr tracks with a per-row floor so every tile stays big enough to
						// show its content; once those floors exceed the height the board scrolls INTERNALLY (the page
						// never scrolls). Focusing lowers the floor to FOCUS_ROW_FLOOR rather than removing it: the
						// neighbours give up their resting composition for their compact one, not their legibility.
						className={cn(
							'grid min-h-0 flex-1 gap-3',
							prefs.scroll ? 'overflow-y-auto' : 'overflow-hidden',
						)}
						style={{
							gridTemplateColumns: trackTemplate(colFr),
							gridTemplateRows: trackTemplate(rowFr, rowMins),
						}}
						role={editing ? 'list' : undefined}
						aria-label={editing ? 'Board tiles — use arrow keys to reorder' : undefined}
					>
						{visible.map((slot, i) => {
							const def = TILE_REGISTRY[slot.tileId];
							const p = placements[i];
							if (!def || !p) return null;
							return (
								<BoardTile
									key={slot.uid}
									def={def}
									slot={slot}
									index={i}
									total={visible.length}
									placement={p}
									ctx={ctx}
									editing={editing}
									focused={slot.uid === activeFocus}
									anyFocus={activeFocus !== null}
									showTable={tableUid === slot.uid && Boolean(def.table)}
									isOver={
										editing &&
										overIndex === i &&
										dragIndex !== null &&
										dragIndex !== i
									}
									dragging={dragIndex === i}
									registerRef={(el) => {
										if (el) tileRefs.current.set(slot.uid, el);
										else tileRefs.current.delete(slot.uid);
									}}
									onExpand={() => openFocus(slot.uid)}
									onClose={() => setFocused(null)}
									onToggleTable={() =>
										setTableUid((u) => (u === slot.uid ? null : slot.uid))
									}
									onConfig={(patch) => setConfig(i, patch)}
									onMove={(dir) => move(i, i + dir)}
									onResize={() => resize(i)}
									onReplace={(id) => replace(i, id)}
									onRemove={() => remove(i)}
									onDragStart={() => setDragIndex(i)}
									onDragEnd={() => {
										setDragIndex(null);
										setOverIndex(null);
									}}
									onDragOver={() => setOverIndex(i)}
									onDrop={() => {
										if (dragIndex !== null) move(dragIndex, i);
										setDragIndex(null);
										setOverIndex(null);
									}}
								/>
							);
						})}
					</div>
				</>
			)}

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
				className="rounded p-0.5 text-[color:var(--faint)] transition hover:text-[color:var(--ink)] disabled:opacity-30"
			>
				<ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
			<button
				type="button"
				onClick={() => onMove(1)}
				disabled={!canLater}
				aria-label={`Move ${title} later`}
				className="rounded p-0.5 text-[color:var(--faint)] transition hover:text-[color:var(--ink)] disabled:opacity-30"
			>
				<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
			<button
				type="button"
				onClick={onResize}
				aria-label={`Resize ${title}, currently ${SIZE_LABEL[slot.size]}`}
				className="rounded px-1.5 py-0.5 font-semibold text-[10px] text-[color:var(--faint)] uppercase ring-1 ring-[color:rgb(var(--border))] transition hover:text-[color:var(--ink)]"
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
					className="rounded p-0.5 text-[color:var(--faint)] transition hover:text-[color:var(--ink)]"
				>
					<Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
				</button>
				{open ? (
					<div className="absolute right-0 z-30 mt-1 max-h-64 w-48 overflow-y-auto rounded-xl border border-[color:rgb(var(--border))] bg-[var(--panel)] p-1 shadow-float ring-1 ring-[color:rgb(var(--border))]">
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
									'block w-full rounded-md px-2.5 py-1.5 text-left text-sm transition hover:bg-[color:rgb(var(--hover))]',
									def.id === slot.tileId
										? 'font-semibold text-accent-700'
										: 'text-[color:var(--ink)] hover:text-[color:var(--ink)]',
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
				className="rounded p-0.5 text-[color:var(--faint)] transition hover:text-neg"
			>
				<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}

/** A labelled row in the config panel. */
function ConfigField({
	label,
	children,
}: {
	label: string;
	children: ReactElement;
}): ReactElement {
	return (
		<div className="flex flex-col gap-1">
			<span className="font-semibold text-[10px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
				{label}
			</span>
			{children}
		</div>
	);
}

/** A pill choice used for chart-style variants and `select` options. */
function ConfigChoice({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactElement | string;
}): ReactElement {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				'rounded-lg border px-2 py-1 font-medium text-[11px] transition',
				active
					? 'border-accent-400 bg-accent-500/15 text-[color:var(--ink)]'
					: 'border-[color:rgb(var(--border))] text-[color:var(--muted)] hover:text-[color:var(--ink)]',
			)}
		>
			{children}
		</button>
	);
}

/** The per-box customization surface shown in a tile's body while customizing: its selectable chart
 * styles (`variants`) and any `options` (select / toggle / colour). Boxes with neither fall back to the
 * grip placeholder. Every change writes the slot's persisted config. */
function TileConfigPanel({
	def,
	config,
	onConfig,
}: {
	def: TileDef;
	config: TileConfig;
	onConfig: (patch: TileConfig) => void;
}): ReactElement {
	const hasControls = Boolean(def.variants?.length || def.options?.length);
	if (!hasControls) {
		return (
			<div className="pointer-events-none flex h-full items-center justify-center gap-2 text-[color:var(--muted)]">
				<GripVertical className="h-5 w-5" aria-hidden="true" />
				<span className="font-medium text-[color:var(--faint)] text-xs uppercase tracking-wide">
					{def.title}
				</span>
			</div>
		);
	}
	return (
		<div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
			{def.variants && def.variants.length > 0 ? (
				<ConfigField label="Chart style">
					<div className="flex flex-wrap gap-1">
						{def.variants.map((v) => (
							<ConfigChoice
								key={v.id}
								active={config.variant === v.id}
								onClick={() => onConfig({ variant: v.id })}
							>
								{v.label}
							</ConfigChoice>
						))}
					</div>
				</ConfigField>
			) : null}
			{(def.options ?? []).map((opt) => (
				<ConfigField key={opt.key} label={opt.label}>
					{opt.type === 'toggle' ? (
						<div className="flex">
							<ConfigChoice
								active={Boolean(config[opt.key])}
								onClick={() => onConfig({ [opt.key]: !config[opt.key] })}
							>
								{config[opt.key] ? 'On' : 'Off'}
							</ConfigChoice>
						</div>
					) : opt.type === 'color' ? (
						<div className="flex flex-wrap gap-1.5">
							{(opt.choices ?? []).map((c) => (
								<button
									key={c.value}
									type="button"
									aria-label={c.label}
									aria-pressed={config[opt.key] === c.value}
									onClick={() => onConfig({ [opt.key]: c.value })}
									className={cn(
										'h-5 w-5 rounded-full ring-2 transition',
										config[opt.key] === c.value
											? 'ring-[color:var(--ink)]'
											: 'ring-transparent hover:ring-[color:rgb(var(--border))]',
									)}
									style={{
										background:
											c.value === 'auto'
												? 'conic-gradient(from 140deg, var(--c1), var(--c2), var(--c3), var(--c1))'
												: c.value,
									}}
								/>
							))}
						</div>
					) : (
						<div className="flex flex-wrap gap-1">
							{(opt.choices ?? []).map((c) => (
								<ConfigChoice
									key={c.value}
									active={config[opt.key] === c.value}
									onClick={() => onConfig({ [opt.key]: c.value })}
								>
									{c.label}
								</ConfigChoice>
							))}
						</div>
					)}
				</ConfigField>
			))}
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
			className="grid min-h-0 flex-1 gap-3 overflow-y-auto"
			style={{
				gridTemplateColumns: trackTemplate(new Array(cols).fill(1)),
				gridTemplateRows: trackTemplate(new Array(rowCount).fill(1), ROW_FLOOR),
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
					className="tile-dark animate-pulse rounded-2xl"
					aria-hidden="true"
				/>
			))}
		</div>
	);
}

/**
 * One placed tile. Extracted from the board's map so it can observe its OWN box: the density tier a
 * box draws at is a function of the pixels it actually got, which the board cannot know for it (the
 * grid's fr tracks are animating, and a focused neighbour changes every other tile's height).
 */
function BoardTile({
	def,
	slot,
	index,
	total,
	placement,
	ctx,
	editing,
	focused,
	anyFocus,
	showTable,
	isOver,
	dragging,
	registerRef,
	onExpand,
	onClose,
	onToggleTable,
	onConfig,
	onMove,
	onResize,
	onReplace,
	onRemove,
	onDragStart,
	onDragEnd,
	onDragOver,
	onDrop,
}: {
	def: TileDef;
	slot: Slot;
	index: number;
	total: number;
	placement: Placement;
	ctx: TileContext;
	editing: boolean;
	focused: boolean;
	anyFocus: boolean;
	showTable: boolean;
	isOver: boolean;
	dragging: boolean;
	registerRef: (el: HTMLDivElement | null) => void;
	onExpand: () => void;
	onClose: () => void;
	onToggleTable: () => void;
	onConfig: (patch: TileConfig) => void;
	onMove: (dir: number) => void;
	onResize: () => void;
	onReplace: (id: string) => void;
	onRemove: () => void;
	onDragStart: () => void;
	onDragEnd: () => void;
	onDragOver: () => void;
	onDrop: () => void;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	const density = useTileDensity(ref, focused);
	const config = resolveTileConfig(def, slot.config);
	const tableData = showTable ? (def.table?.(ctx, config) ?? null) : null;

	return (
		<div
			ref={(el) => {
				ref.current = el;
				registerRef(el);
			}}
			role={editing ? 'listitem' : undefined}
			aria-label={
				editing
					? `${def.title}, position ${index + 1} of ${total}. Use arrow keys to move.`
					: undefined
			}
			tabIndex={editing ? 0 : undefined}
			data-density={density}
			style={
				{
					gridColumn: `${placement.colStart} / span ${placement.colSpan}`,
					gridRow: `${placement.rowStart} / span ${placement.rowSpan}`,
					// Reading order, capped: the board should feel dealt out, not loaded. Past the
					// tenth tile the delay stops growing, so the last tile is never late enough to
					// read as a slow board.
					'--tile-i': Math.min(index, 9),
				} as CSSProperties
			}
			className={cn(
				'tile-enter min-h-0 rounded-2xl transition-[opacity,filter] duration-300',
				focused && 'relative z-20',
				// No focus:outline-none: it suppressed the shell's token focus outline on the one
				// draggable control that is a bare div.
				editing && 'cursor-grab',
				dragging && 'opacity-40',
				isOver && 'ring-2 ring-accent-400 ring-offset-2',
				// Recede, but stay READABLE and CLICKABLE. This used to be
				// `pointer-events-none opacity-40`, which made an unfocused tile both hard to read
				// and impossible to click — the second half of why you could not expand a different
				// tile without closing the first one.
				anyFocus && !focused && 'opacity-75',
			)}
			draggable={editing}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onDragOver={(e) => {
				if (!editing) return;
				e.preventDefault();
				onDragOver();
			}}
			onDrop={(e) => {
				e.preventDefault();
				onDrop();
			}}
			onKeyDown={(e) => {
				if (!editing) return;
				if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
					e.preventDefault();
					onMove(-1);
				} else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
					e.preventDefault();
					onMove(1);
				}
			}}
		>
			<BentoTile
				label={def.selfLabeled ? undefined : def.title}
				emphasis={def.emphasis}
				focused={focused}
				density={density}
				action={
					editing ? (
						<TileControls
							slot={slot}
							title={def.title}
							canEarlier={index > 0}
							canLater={index < total - 1}
							onMove={onMove}
							onResize={onResize}
							onReplace={onReplace}
							onRemove={onRemove}
						/>
					) : (
						def.action?.(ctx)
					)
				}
				// Expandable from ANY position, including while another tile is focused: expanding a
				// second tile moves the focus rather than being refused. Only the already-focused
				// tile withholds the control, because it shows Close instead.
				onExpand={!editing && def.expandable && !focused ? onExpand : undefined}
				onClose={focused ? onClose : undefined}
				onToggleTable={def.table && !editing ? onToggleTable : undefined}
				tableActive={showTable}
				className="h-full"
				bodyClassName={
					def.expandable || focused || showTable ? 'overflow-y-auto' : undefined
				}
			>
				{editing ? (
					<TileConfigPanel def={def} config={config} onConfig={onConfig} />
				) : tableData ? (
					<DataTable data={tableData} />
				) : (
					def.render(ctx, density, config)
				)}
			</BentoTile>
		</div>
	);
}
