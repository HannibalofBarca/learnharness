"use client";

/** FOCUS HYGIENE — transient transcript controls don't keep focus. */

/** Attach as (or compose into) a transient control's onClick: blurs the
 *  control after POINTER clicks (keyboard clicks keep focus). Node-safe
 *  duck-typing — no HTMLElement global needed (the test harness runs
 *  bare node with linkedom). */
export function blurAfterPointerClick(e: {
	detail: number;
	currentTarget: EventTarget | null;
}): void {
	if (e.detail === 0) return;
	const el = e.currentTarget as { blur?: unknown } | null;
	if (el && typeof el.blur === "function") (el.blur as () => void).call(el);
}
