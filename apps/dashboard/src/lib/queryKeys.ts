// Every react-query key for data scoped to one site is built here. The site id always lands as a
// literal element right after the scope, so `queryKeyReferencesSite` (used on site switch, see
// App.tsx) can check that shape by construction instead of guessing at conventions a new hook
// might not follow — see the site-scoped cache eviction on `useEffect([siteId])` in App.tsx.

/** Build a query key for data scoped to one site. `scope` is the existing free-form key prefix
 * (a single string, or an array for a nested domain like `['crm', 'contacts']`). */
export function siteQueryKey(
	scope: string | readonly string[],
	siteId: string,
	...rest: unknown[]
): readonly unknown[] {
	const prefix = Array.isArray(scope) ? scope : [scope];
	return [...prefix, siteId, ...rest];
}

/** True when `key` was built by `siteQueryKey` for `siteId`: the factory always places the site
 * id as a literal element, so membership is exact rather than inferred from a key's shape. */
export function queryKeyReferencesSite(key: readonly unknown[], siteId: string): boolean {
	return siteId ? key.includes(siteId) : false;
}
