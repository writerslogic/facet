// Per-site bento layout persistence: the default fallback, the sanitize contract (drop unknown tile
// ids and invalid sizes, backfill uids), and the hook's persist/reset/re-seed behaviour.

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readBoardLayout, useBoardLayout } from '../lib/boardLayout.js';
import { DEFAULT_LAYOUT } from '../lib/tiles.js';

const KEY = (site: string): string => `facet.board.${site}`;

afterEach(() => {
	localStorage.clear();
});

describe('readBoardLayout', () => {
	it('returns the default layout when nothing is stored', () => {
		expect(readBoardLayout('s1')).toEqual(DEFAULT_LAYOUT);
	});

	it('falls back to the default on unparseable JSON', () => {
		localStorage.setItem(KEY('s1'), '{not json');
		expect(readBoardLayout('s1')).toEqual(DEFAULT_LAYOUT);
	});

	it('drops slots with an unknown tile id or an invalid size, keeping valid ones', () => {
		localStorage.setItem(
			KEY('s1'),
			JSON.stringify([
				{ uid: 'a', tileId: 'pageviews', size: 'kpi' },
				{ uid: 'b', tileId: 'nope', size: 'kpi' },
				{ uid: 'c', tileId: 'pages', size: 'huge' },
			]),
		);
		const layout = readBoardLayout('s1');
		expect(layout).toHaveLength(1);
		expect(layout[0]).toMatchObject({ tileId: 'pageviews', size: 'kpi' });
	});

	it('falls back to the default when nothing survives sanitizing', () => {
		localStorage.setItem(KEY('s1'), JSON.stringify([{ tileId: 'nope', size: 'kpi' }]));
		expect(readBoardLayout('s1')).toEqual(DEFAULT_LAYOUT);
	});

	it('backfills a uid for slots saved before slots had one', () => {
		localStorage.setItem(KEY('s1'), JSON.stringify([{ tileId: 'pageviews', size: 'kpi' }]));
		const [slot] = readBoardLayout('s1');
		expect(typeof slot?.uid).toBe('string');
		expect(slot?.uid).not.toBe('');
	});

	it('repairs duplicate uids so keys stay unique', () => {
		localStorage.setItem(
			KEY('s1'),
			JSON.stringify([
				{ uid: 'dup', tileId: 'pageviews', size: 'kpi' },
				{ uid: 'dup', tileId: 'visitors', size: 'kpi' },
			]),
		);
		const layout = readBoardLayout('s1');
		expect(new Set(layout.map((s) => s.uid)).size).toBe(2);
	});
});

describe('useBoardLayout', () => {
	it('persists setSlots to the site key and reset clears it', () => {
		const { result } = renderHook(() => useBoardLayout('s1'));
		const next = [{ uid: 'x', tileId: 'pages', size: 'lg' as const }];
		act(() => result.current.setSlots(next));
		expect(JSON.parse(localStorage.getItem(KEY('s1')) ?? '[]')).toEqual(next);
		act(() => result.current.reset());
		expect(localStorage.getItem(KEY('s1'))).toBeNull();
		expect(result.current.slots).toEqual(DEFAULT_LAYOUT);
	});

	it('re-seeds from the new key when the site changes', () => {
		localStorage.setItem(
			KEY('s2'),
			JSON.stringify([{ uid: 'only', tileId: 'flow', size: 'tall' }]),
		);
		const { result, rerender } = renderHook(({ site }) => useBoardLayout(site), {
			initialProps: { site: 's1' },
		});
		expect(result.current.slots).toEqual(DEFAULT_LAYOUT);
		rerender({ site: 's2' });
		expect(result.current.slots).toHaveLength(1);
		expect(result.current.slots[0]).toMatchObject({
			tileId: 'flow',
			size: 'tall',
		});
	});
});
