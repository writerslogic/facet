// The focus contract every `aria-modal="true"` overlay owes: move focus in on open, keep Tab inside
// while it is open, close on Escape, and put focus back where it came from on close. The proof drawer
// implemented all four privately; the site-profile dialog implemented none of them, so it announced
// itself as modal while Tab walked straight out into the page behind it and Escape did nothing.

import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE =
	'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useDialogFocus(
	panelRef: RefObject<HTMLElement | null>,
	onClose: () => void,
	/** Where focus should land on open. Defaults to the first focusable control in the panel. */
	initialRef?: RefObject<HTMLElement | null>,
): void {
	// Most callers pass an inline `() => setOpen(false)`, a fresh closure every render. Depending
	// on it directly would tear down and rebuild this effect (stealing focus back to `first`, then
	// forward again) on every unrelated re-render of the caller while the dialog stays open.
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const first =
			initialRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
		first?.focus();

		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') {
				onCloseRef.current();
				return;
			}
			if (e.key !== 'Tab') return;
			const items = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
			if (!items || items.length === 0) return;
			const head = items[0];
			const tail = items[items.length - 1];
			if (e.shiftKey && document.activeElement === head) {
				e.preventDefault();
				tail?.focus();
			} else if (!e.shiftKey && document.activeElement === tail) {
				e.preventDefault();
				head?.focus();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('keydown', onKey);
			previous?.focus?.();
		};
	}, [panelRef, initialRef]);
}
