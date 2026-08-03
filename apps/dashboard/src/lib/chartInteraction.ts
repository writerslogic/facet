// Shared interaction primitives for every chart on the board.
//
// WHY THIS EXISTS: the dashboard grew charts one at a time, and each invented its own hover state,
// its own easing, and its own reduced-motion check (there are four hand-rolled copies of the latter
// in the tree). That is how a dashboard ends up with three visual languages and an accessibility
// audit that has to unpick all of them. Anything a chart does on pointer, drill-down or transition
// belongs here so every chart feels like the same product.

import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';

/** True when the visitor asked for reduced motion. Every animated helper here honours it. */
export function prefersReducedMotion(): boolean {
	return (
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/**
 * Critically-damped spring, integrated per frame. Springs rather than fixed-duration easing because
 * a spring retargets mid-flight without a visible discontinuity: drill into a node while the last
 * transition is still running and it bends toward the new value instead of snapping and restarting.
 * `stiffness`/`damping` are in the usual UI range; the defaults settle in ~350ms.
 */
export function useSpring(
	target: number,
	{ stiffness = 170, damping = 26 }: { stiffness?: number; damping?: number } = {},
): number {
	const [value, setValue] = useState(target);
	const state = useRef({ current: target, velocity: 0 });
	const frame = useRef<number | null>(null);

	useEffect(() => {
		// Reduced motion is not "a faster animation" — it is no animation. Jump and stop.
		if (prefersReducedMotion()) {
			state.current = { current: target, velocity: 0 };
			setValue(target);
			return;
		}
		let last = performance.now();
		const step = (now: number): void => {
			// Clamp dt so a backgrounded tab returning after seconds doesn't explode the integrator.
			const dt = Math.min((now - last) / 1000, 1 / 30);
			last = now;
			const s = state.current;
			const force = -stiffness * (s.current - target) - damping * s.velocity;
			s.velocity += force * dt;
			s.current += s.velocity * dt;
			// Settle: below both thresholds the motion is sub-pixel, so stop scheduling frames.
			if (Math.abs(s.current - target) < 0.01 && Math.abs(s.velocity) < 0.01) {
				s.current = target;
				s.velocity = 0;
				setValue(target);
				frame.current = null;
				return;
			}
			setValue(s.current);
			frame.current = requestAnimationFrame(step);
		};
		frame.current = requestAnimationFrame(step);
		return () => {
			if (frame.current != null) cancelAnimationFrame(frame.current);
			frame.current = null;
		};
	}, [target, stiffness, damping]);

	return value;
}

/** Where a tooltip should sit, in container-relative pixels, plus the datum under the pointer. */
export interface HoverTarget<T> {
	datum: T;
	x: number;
	y: number;
}

/**
 * Pointer tracking for a chart, reported in coordinates relative to `ref`'s box so a tooltip can be
 * positioned without reading layout again. `resolve` maps a local point to a datum, or null for
 * "nothing here" — which clears the hover rather than leaving the last value stuck under the cursor.
 *
 * Pointer events (not mouse) so pen and touch behave; touch gets a tap-to-inspect for free.
 */
export function useHoverTarget<T>(
	ref: RefObject<HTMLElement | null>,
	resolve: (localX: number, localY: number) => T | null,
): {
	hover: HoverTarget<T> | null;
	handlers: {
		onPointerMove: (e: ReactPointerEvent) => void;
		onPointerLeave: () => void;
	};
} {
	const [hover, setHover] = useState<HoverTarget<T> | null>(null);
	// Keep `resolve` in a ref: chart callbacks are usually rebuilt every render from fresh data, and
	// depending on it directly would reinstall the handler on every frame.
	const resolveRef = useRef(resolve);
	resolveRef.current = resolve;

	const onPointerMove = useCallback(
		(e: ReactPointerEvent) => {
			const el = ref.current;
			if (!el) return;
			const box = el.getBoundingClientRect();
			const x = e.clientX - box.left;
			const y = e.clientY - box.top;
			const datum = resolveRef.current(x, y);
			setHover(datum == null ? null : { datum, x, y });
		},
		[ref],
	);

	const onPointerLeave = useCallback(() => setHover(null), []);

	return { hover, handlers: { onPointerMove, onPointerLeave } };
}

/**
 * A drill-down stack. Charts that zoom into a hierarchy (sunburst, treemap) all need the same three
 * things: where am I, how did I get here, and how do I go back. Keeping it here means the breadcrumb
 * reads identically whichever chart you drilled from.
 */
export function useDrillPath<T>(root: T): {
	path: T[];
	current: T;
	depth: number;
	drillTo: (node: T) => void;
	back: () => void;
	reset: () => void;
	/** Jump to a specific breadcrumb index (0 = root). */
	jumpTo: (index: number) => void;
} {
	const [path, setPath] = useState<T[]>([root]);

	// A new root means new data (site switch, range change, filter). Anything below it is stale, and
	// silently keeping a drill position from the previous dataset would show the wrong subtree.
	useEffect(() => {
		setPath([root]);
	}, [root]);

	const drillTo = useCallback((node: T) => setPath((p) => [...p, node]), []);
	const back = useCallback(() => setPath((p) => (p.length > 1 ? p.slice(0, -1) : p)), []);
	const reset = useCallback(() => setPath((p) => (p.length > 1 ? [p[0] as T] : p)), []);
	const jumpTo = useCallback(
		(index: number) => setPath((p) => (index < p.length ? p.slice(0, index + 1) : p)),
		[],
	);

	const current = path[path.length - 1] as T;
	return useMemo(
		() => ({ path, current, depth: path.length - 1, drillTo, back, reset, jumpTo }),
		[path, current, drillTo, back, reset, jumpTo],
	);
}

/**
 * Series selection for multi-line charts: one selected key dims the rest. Returns the opacity a
 * series should render at, so every chart fades by the same amount.
 */
export function useSeriesFocus(): {
	focused: string | null;
	setFocused: (key: string | null) => void;
	toggle: (key: string) => void;
	opacityFor: (key: string) => number;
	isDimmed: (key: string) => boolean;
} {
	const [focused, setFocused] = useState<string | null>(null);
	const toggle = useCallback((key: string) => setFocused((f) => (f === key ? null : key)), []);
	// 0.18 keeps a dimmed line visible as context without competing with the focused one. Not 0:
	// hiding the others would change what the chart says, not just what it emphasises.
	const opacityFor = useCallback(
		(key: string) => (focused == null || focused === key ? 1 : 0.18),
		[focused],
	);
	const isDimmed = useCallback((key: string) => focused != null && focused !== key, [focused]);
	return { focused, setFocused, toggle, opacityFor, isDimmed };
}
