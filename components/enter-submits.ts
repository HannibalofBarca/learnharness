"use client";

/** ENTER SUBMITS — regardless of where focus is. */

import { useEffect, useRef } from "react";
import { isTypingSurface } from "@/src/core";

/** Overlay roots whose buttons keep native Enter (hand-rolled menus mark themselves data-lh-menu; Radix poppers/dialogs carry their own attrs). */
const OVERLAY_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]';

/** Pure decision, exported for pins: does a focused BUTTON keep native
 *  Enter (true) or does Enter belong to submit (false)? */
function buttonKeepsNativeEnter(el: HTMLElement): boolean {
	// Keyboard-walked focus: the menu arrows landed here — Enter activates.
	try {
		if (el.matches(":focus-visible")) return true;
	} catch {
		// unsupported pseudo — treat as pointer focus
	}
	// Inside an open overlay: the overlay owns its keys.
	return !!el.closest(OVERLAY_ROOTS);
}

/** Mount-scoped: while the dock is mounted (a problem/question is active), plain Enter anywhere outside a typing surface or button submits it. */
export function useEnterSubmits(submit: () => void): void {
	const submitRef = useRef(submit);
	submitRef.current = submit;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Enter") return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			if (isTypingSurface(e)) return;
			const target = e.target as HTMLElement | null;
			if (target?.tagName === "BUTTON" && buttonKeepsNativeEnter(target)) return;
			e.preventDefault();
			submitRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
