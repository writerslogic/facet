// One dismissal contract for every popover in the app: Escape closes and returns focus to the trigger,
// a pointer-down outside closes without stealing focus. It lived privately inside BentoBoard, so the
// three popovers in the header (site switcher, date range, export) each had their own partial version —
// none of them handled Escape, which is the one dismissal a keyboard user has.

import { type RefObject, useEffect } from 'react';

export function usePopoverDismiss(
	open: boolean,
	close: () => void,
	wrapRef: RefObject<HTMLElement | null>,
	toggleRef: RefObject<HTMLElement | null>,
): void {
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== 'Escape') return;
			// Stop here: a popover inside a dialog must not close the dialog with the same keypress.
			e.stopPropagation();
			close();
			toggleRef.current?.focus();
		};
		const onDown = (e: PointerEvent): void => {
			if (!wrapRef.current?.contains(e.target as Node)) close();
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('pointerdown', onDown);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', onDown);
		};
	}, [open, close, wrapRef, toggleRef]);
}
