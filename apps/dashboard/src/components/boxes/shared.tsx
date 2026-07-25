// Shared building blocks for boxes. `ListBody` is the ranked-list body used by every dimension box
// (pages, referrers, devices, channels, events): a bare, dark, size-fitting TopList.

import type { CountRow } from '@facet/shared';
import type { ReactNode } from 'react';
import { TopList } from '../TopList.js';
import type { TableData } from './types.js';

/** A ranked-list box's data as a table: name, count, and share-of-total percent. */
export function rowsTable(nameCol: string, rows: CountRow[]): TableData {
	const total = rows.reduce((s, r) => s + r.count, 0);
	return {
		columns: [nameCol, 'Count', 'Share %'],
		rows: rows.map((r) => [
			r.key,
			r.count,
			total > 0 ? Math.round((r.count / total) * 100) : 0,
		]),
	};
}

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
