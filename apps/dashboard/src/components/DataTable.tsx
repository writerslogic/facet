// Raw-data table view for a box (the "view as table" toggle). Renders a box's TableData as a scrollable,
// themed table and offers one-click copy (TSV → clipboard) so users can paste the numbers elsewhere.

import { Check, Copy } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { cn } from '../lib/cn.js';
import type { TableData } from './boxes/types.js';

export function DataTable({ data }: { data: TableData }): ReactElement {
	const [copied, setCopied] = useState(false);
	const copy = async (): Promise<void> => {
		const tsv = [data.columns.join('\t'), ...data.rows.map((r) => r.join('\t'))].join('\n');
		try {
			await navigator.clipboard.writeText(tsv);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard blocked (insecure context / permissions) — silently ignore
		}
	};
	return (
		<div className="flex h-full flex-col">
			<div className="mb-2 flex shrink-0 justify-end">
				<button
					type="button"
					onClick={copy}
					className="inline-flex items-center gap-1.5 rounded-md border border-[color:rgb(var(--border))] px-2 py-1 font-medium text-[11px] text-[color:var(--muted)] transition hover:text-[color:var(--ink)]"
				>
					{copied ? (
						<Check className="h-3 w-3" aria-hidden="true" />
					) : (
						<Copy className="h-3 w-3" aria-hidden="true" />
					)}
					{copied ? 'Copied' : 'Copy'}
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[color:rgb(var(--border))]">
				<table className="w-full text-sm">
					<thead className="sticky top-0 bg-[var(--panel)]">
						<tr>
							{data.columns.map((c, i) => (
								<th
									key={c}
									className={cn(
										'px-2.5 py-1.5 font-semibold text-[10px] text-[color:var(--faint)] uppercase tracking-[0.06em]',
										i === 0 ? 'text-left' : 'text-right',
									)}
								>
									{c}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{data.rows.map((row, ri) => (
							<tr
								// biome-ignore lint/suspicious/noArrayIndexKey: rows are a static snapshot; index is a stable identity here
								key={ri}
								className="border-[color:rgb(var(--border))] border-t"
							>
								{row.map((cell, ci) => (
									<td
										key={`${data.columns[ci] ?? ci}`}
										className={cn(
											'px-2.5 py-1',
											ci === 0
												? 'text-[color:var(--ink)]'
												: 'text-right text-[color:var(--muted)] tabular-nums',
										)}
									>
										{cell}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
