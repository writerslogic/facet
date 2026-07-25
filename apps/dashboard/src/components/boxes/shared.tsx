// Shared building blocks for boxes. `ListBody` is the ranked-list body used by every dimension box
// (pages, referrers, devices, channels, events): a bare, dark, size-fitting TopList.

import type { CountRow } from '@facet/shared';
import type { ReactNode } from 'react';
import { TopList } from '../TopList.js';

export function ListBody({
	title,
	rows,
	onSelect,
	activeKey,
	expanded,
}: {
	title: string;
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	expanded?: boolean;
}): ReactNode {
	return (
		<TopList
			bare
			dark
			fit
			limit={expanded ? 25 : 6}
			title={title}
			rows={rows}
			onSelect={onSelect}
			activeKey={activeKey}
		/>
	);
}
