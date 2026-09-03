// Overview board settings: whether the board may scroll, and the entry point into layout editing.
// These are per-site browser preferences (localStorage), not deployment config, so this panel renders
// on either side of the admin-token gate the same way AppearancePanel does.

import type { ReactElement } from 'react';
import { useBoardLayout, useBoardPrefs } from '../../lib/boardLayout.js';
import { DEFAULT_LAYOUT } from '../../lib/tiles.js';
import { useDashboard } from '../../state.js';

export function BoardPanel({ onEditLayout }: { onEditLayout: () => void }): ReactElement | null {
	const { activeProfile } = useDashboard();
	const siteId = activeProfile?.siteId ?? '';
	const { prefs, setPrefs } = useBoardPrefs(siteId);
	const { slots, reset } = useBoardLayout(siteId);

	if (!siteId) return null;

	return (
		<div className="surface rounded-xl p-4">
			<h2 className="font-semibold text-[color:var(--ink)] text-sm">Overview board</h2>
			<p className="mt-1 text-[color:var(--muted)] text-xs">
				Arrange the six essential tiles or add insights from the library. Stored in this
				browser, per site.
			</p>

			<label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-[color:rgb(var(--border))] p-3">
				<input
					type="checkbox"
					checked={prefs.scroll}
					onChange={(e) => setPrefs({ ...prefs, scroll: e.target.checked })}
					className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--accent-500)]"
				/>
				<span className="min-w-0">
					<span className="block font-medium text-[color:var(--ink)] text-sm">
						Allow the board to scroll
					</span>
					<span className="mt-0.5 block text-[color:var(--muted)] text-xs">
						Off, the resting board fits the window and offers Show more when needed.
						Editing always shows every tile. On, the full board scrolls at rest too.
					</span>
				</span>
			</label>

			<div className="mt-3 flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={onEditLayout}
					className="btn-accent inline-flex items-center rounded-lg px-3 py-1.5 text-xs shadow-card transition"
				>
					Edit layout
				</button>
				<button
					type="button"
					onClick={reset}
					disabled={slots === DEFAULT_LAYOUT}
					className="inline-flex items-center rounded-lg border border-[color:rgb(var(--border))] bg-[var(--panel)] px-3 py-1.5 font-medium text-[color:var(--ink)] text-xs shadow-card transition disabled:opacity-40"
				>
					Reset to default
				</button>
				<span className="text-[color:var(--faint)] text-xs">
					{slots.length} {slots.length === 1 ? 'tile' : 'tiles'}
				</span>
			</div>
		</div>
	);
}
