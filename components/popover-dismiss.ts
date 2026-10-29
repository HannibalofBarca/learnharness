import { useEffect, type RefObject } from "react";

/** Close-on-dismissal for floating panels: any pointerdown landing OUTSIDE the control's root closes it; Escape closes it too. */
export function usePopoverDismiss(
	rootRef: RefObject<HTMLElement | null>,
	open: boolean,
	close: () => void,
): void {
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Claim the Esc: the window-level dismiss chain must not ALSO stop dictation / abort a turn under this popover.
				e.stopPropagation();
				close();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, close, rootRef]);
}
