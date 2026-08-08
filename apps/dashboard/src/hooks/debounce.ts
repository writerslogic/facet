// A generic debounced-value hook. Extracted from three CRM panels (ContactsPanel, CompaniesPanel,
// DealsPanel) that each hand-rolled the identical setTimeout/clearTimeout pair for a search box.

import { useEffect, useState } from 'react';

/** Returns `value`, updated `delayMs` after it stops changing. Typed generically since every current
 * caller debounces a search string, but nothing here assumes that. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);
	return debounced;
}
