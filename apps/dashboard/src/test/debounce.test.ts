// useDebouncedValue is the search-debounce hook shared by the three CRM panels. The one behavior
// worth pinning: `onSettle` must land in the SAME render as the debounced value update, not a render
// later — a caller resetting a page offset from a separate effect watching the returned value would
// otherwise let one render (and one `useQuery` call, in the real panels) go out with the new value and
// the stale offset.

import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from '../hooks/debounce.js';

describe('useDebouncedValue', () => {
	it('updates the value after the delay', () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
			initialProps: { value: 'a' },
		});
		expect(result.current).toBe('a');
		rerender({ value: 'ab' });
		expect(result.current).toBe('a');
		act(() => vi.advanceTimersByTime(300));
		expect(result.current).toBe('ab');
		vi.useRealTimers();
	});

	it('never renders the new value paired with a not-yet-reset offset', () => {
		vi.useFakeTimers();
		const renders: { query: string; offset: number }[] = [];
		function useProbe(search: string) {
			// Starts "paged", mirroring a panel mid-roster when a new search term arrives.
			const [offset, setOffset] = useState(10);
			const query = useDebouncedValue(search, 300, () => setOffset(0));
			renders.push({ query, offset });
			return { query, offset };
		}
		const { rerender } = renderHook(({ search }) => useProbe(search), {
			initialProps: { search: 'a' },
		});
		renders.length = 0;
		rerender({ search: 'ab' });
		act(() => vi.advanceTimersByTime(300));

		const mismatched = renders.find((r) => r.query === 'ab' && r.offset !== 0);
		expect(mismatched).toBeUndefined();
		expect(renders.some((r) => r.query === 'ab' && r.offset === 0)).toBe(true);
		vi.useRealTimers();
	});
});
