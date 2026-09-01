// Languages box: ranked list of visitor primary languages (Accept-Language subtag; k-anonymised).
//
// The stored value is a bare subtag — `primaryLanguage` in the worker's request-meta drops region,
// q-values and secondary languages because the full ordered list is a strong fingerprint. A subtag is
// an identifier, not a label, so rows are named through Intl in the VISITOR's locale, the same rule
// every date and number on this board follows: a German operator reads "Englisch", not "en". ICU data
// is in the browser, so naming costs no request.
//
// Not drillable: language is not a filterable dimension in the API (see BrowsersBox).

import type { CountRow } from '@facet/shared';
import { uiLocale } from '../../lib/datetime.js';
import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

let namerLocale: string | undefined | null = null;
let namer: Intl.DisplayNames | null = null;

/** The language namer for the current UI locale, rebuilt only when that locale changes. Null on a
 * runtime without `Intl.DisplayNames`, which leaves every row showing its subtag. */
function languageNamer(): Intl.DisplayNames | null {
	const locale = uiLocale();
	if (namerLocale === locale) return namer;
	namerLocale = locale;
	try {
		namer = new Intl.DisplayNames(locale, { type: 'language', fallback: 'code' });
	} catch {
		namer = null;
	}
	return namer;
}

/** `of` throws on a malformed tag rather than falling back, and an imported row can carry anything. */
function nameOf(code: string, names: Intl.DisplayNames | null): string {
	if (!names) return code;
	try {
		return names.of(code) ?? code;
	} catch {
		return code;
	}
}

/** Rows relabelled to language names. Tags naming the same language fold into one row — `en` and the
 * ISO 639-2 `eng` an import can write both name English, and two rows under one label would read as a
 * duplicate and collide as list keys. `primaryOnly` drops a region subtag before naming, so an
 * imported `en-US` names "English" rather than ICU's "American English" and folds in with `en-GB`. */
function namedRows(rows: readonly CountRow[] | undefined, primaryOnly: boolean): CountRow[] {
	if (!rows || rows.length === 0) return [];
	const names = languageNamer();
	const merged = new Map<string, number>();
	for (const row of rows) {
		const key = nameOf(primaryOnly ? (row.key.split('-')[0] ?? row.key) : row.key, names);
		merged.set(key, (merged.get(key) ?? 0) + row.count);
	}
	return [...merged].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

export const languagesBox: TileDef = {
	id: 'languages',
	title: 'Languages',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Language', namedRows(ctx.data.top_languages, false)),
	render: (ctx, density, config) => {
		// Compact is a single truncating line, so the label has to be one word wide: "American English"
		// clips to a few characters at that width where "English" fits whole.
		const primaryOnly = density === 'compact';
		const rows = namedRows(ctx.data.top_languages, primaryOnly);
		return (
			<ListBody
				title="Languages"
				rows={rows}
				density={density}
				config={config}
				// Both sides are named the same way: movements key on the row label, so comparing
				// named rows against raw subtags would drop every delta on the list.
				compare={{ current: rows, select: (p) => namedRows(p.top_languages, primaryOnly) }}
				drill={drillSpec(ctx, null)}
				noun="Language"
			/>
		);
	},
};
