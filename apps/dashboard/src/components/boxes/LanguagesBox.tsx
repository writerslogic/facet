// Languages box: ranked list of visitor primary languages (Accept-Language subtag; k-anonymised).
//
// Not drillable: language is not a filterable dimension in the API (see BrowsersBox).

import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const languagesBox: TileDef = {
	id: 'languages',
	title: 'Languages',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Language', ctx.data.top_languages ?? []),
	render: (ctx, expanded, config) => (
		<ListBody
			title="Languages"
			rows={ctx.data.top_languages ?? []}
			expanded={expanded}
			config={config}
			compare={{ current: ctx.data.top_languages ?? [], select: (p) => p.top_languages }}
			drill={drillSpec(ctx, null)}
			noun="Language"
		/>
	),
};
