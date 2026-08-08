// A generic debounced-value hook. Extracted from three CRM panels (ContactsPanel, CompaniesPanel,
// DealsPanel) that each hand-rolled the identical setTimeout/clearTimeout pair for a search box.

import { useEffect, useRef, useState } from 'react';

/** Returns `value`, updated `delayMs` after it stops changing. `onSettle` fires in the SAME tick as
 * the internal update rather than a separate `useEffect` watching the return value — a caller resetting
 * a page offset that way would fire one render (and one `useQuery` call) with the new value and the
 * stale offset before the effect corrects it. */
export function useDebouncedValue<T>(value: T, delayMs: number, onSettle?: (value: T) => void): T {
	const [debounced, setDebounced] = useState(value);
	// A ref, not a dependency: `onSettle` is typically a fresh closure every render, and it must not
	// restart the timer just because the caller re-rendered for an unrelated reason.
	const onSettleRef = useRef(onSettle);
	onSettleRef.current = onSettle;
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebounced(value);
			onSettleRef.current?.(value);
		}, delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);
	return debounced;
}
