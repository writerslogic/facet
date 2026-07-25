// Measure an element's content box (ResizeObserver). Lets a tile pick a view that fits its current
// size — essential on the elastic board, where focusing one tile squishes every other to arbitrary
// dimensions and each must still render something well-formatted.

import { type RefObject, useEffect, useState } from 'react';

export function useSize(ref: RefObject<HTMLElement | null>): {
	width: number;
	height: number;
} {
	const [size, setSize] = useState({ width: 0, height: 0 });
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = (): void => setSize({ width: el.clientWidth, height: el.clientHeight });
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return size;
}
