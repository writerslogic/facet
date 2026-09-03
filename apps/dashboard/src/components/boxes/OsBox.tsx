// Operating systems box: ranked list of visitor OS families (UA client hints; k-anonymised server-side).
//
// Not drillable: OS is not a filterable dimension in the API (see BrowsersBox).

import { drillSpec } from './drill.js';
import { ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const osBox: TileDef = {
	table: (ctx) => rowsTable('OS', ctx.data.top_os ?? []),
	render: (ctx, density, config) => (
		<ListBody
			title="Operating systems"
			rows={ctx.data.top_os ?? []}
			density={density}
			config={config}
			compare={{ current: ctx.data.top_os ?? [], select: (p) => p.top_os }}
			drill={drillSpec(ctx, null)}
			noun="Operating system"
		/>
	),
};
