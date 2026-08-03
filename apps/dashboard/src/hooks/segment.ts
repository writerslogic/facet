// The segment context: the one place every tab reads and writes the current cross-filter.
//
// A context rather than props because the alternative is threading `filter` + `onFilterChange` +
// `serverFilter` + `onServerFilterChange` through eight tab components, most of which only need the
// value to say they cannot honour it. The transitions themselves are a pure reducer in
// lib/segment.ts, so what happens to a segment is testable without React.
//
// `createElement` instead of JSX so this stays a `.ts` module alongside its siblings — the same
// approach state.ts takes for the dashboard store.

import {
	type ReactElement,
	type ReactNode,
	createContext,
	createElement,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
} from 'react';
import {
	EMPTY_SEGMENT,
	type Segment,
	type SegmentKey,
	isSegmentActive,
	readSegmentFromUrl,
	segmentReducer,
	writeSegmentToUrl,
} from '../lib/segment.js';

export interface SegmentStore {
	segment: Segment;
	/** True when any dimension is constrained. */
	active: boolean;
	/** Replace the whole segment (used by "Investigate", which must also drop what was set before). */
	setSegment: (segment: Segment) => void;
	/** Click-to-filter: setting the value already in force clears it. */
	toggle: (key: SegmentKey, value: string) => void;
	remove: (key: SegmentKey) => void;
	clear: () => void;
}

/**
 * The default store: an inert, always-empty segment.
 *
 * Deliberately not a throw. A tab rendered outside the provider (every per-component test does this)
 * must behave as "no segment", not crash — and "no segment" is the safe direction: the numbers are
 * unfiltered and nothing on screen claims otherwise. `App` always mounts the provider; a test pins
 * that so the fallback can never quietly become the production path.
 */
const INERT: SegmentStore = {
	segment: EMPTY_SEGMENT,
	active: false,
	setSegment: () => {},
	toggle: () => {},
	remove: () => {},
	clear: () => {},
};

const SegmentContext = createContext<SegmentStore>(INERT);

export function SegmentProvider({ children }: { children: ReactNode }): ReactElement {
	// Seeded from the URL so a shared link and a reload both land on the same filtered view.
	const [segment, dispatch] = useReducer(segmentReducer, undefined, () => readSegmentFromUrl());

	// One writer, one direction: state changes, the URL follows. Doing it here rather than inside
	// each action keeps the URL impossible to desynchronise from the value the tabs are rendering.
	useEffect(() => {
		writeSegmentToUrl(segment);
	}, [segment]);

	const setSegment = useCallback((next: Segment) => dispatch({ type: 'set', segment: next }), []);
	const toggle = useCallback(
		(key: SegmentKey, value: string) => dispatch({ type: 'toggle', key, value }),
		[],
	);
	const remove = useCallback((key: SegmentKey) => dispatch({ type: 'remove', key }), []);
	const clear = useCallback(() => dispatch({ type: 'clear' }), []);

	const store = useMemo<SegmentStore>(
		() => ({
			segment,
			active: isSegmentActive(segment),
			setSegment,
			toggle,
			remove,
			clear,
		}),
		[segment, setSegment, toggle, remove, clear],
	);

	return createElement(SegmentContext.Provider, { value: store }, children);
}

export function useSegment(): SegmentStore {
	return useContext(SegmentContext);
}
