"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** THE shared menu shell: one placement body for the app's dropdown menus — portaled to document.body (never clipped by an ancestor's overflow) */

const GAP = 4; // anchor edge → menu (the bespoke shells' settled 4px)
const EDGE = 8; // viewport floor the menu never enters
const CAP_VH = 0.6; // 60vh — the graph pattern's cap
const MIN_USABLE = 96; // floor: a shorter cap is an unusable sliver; the
// cap then overflows the edge instead of crushing the menu

/** A MenuShell mounted = a dropdown open. */
export const MENU_OPEN_EVENT = "lh:menu-open";
export const MENU_CLOSE_EVENT = "lh:menu-close";

type MenuSide = "up" | "down";
type MenuAlign = "left" | "right";

/** One placement decision. */
interface MenuPlacement {
	side: MenuSide;
	style: Record<string, string | number>;
	maxHeight: number;
}

/** Pure: the placement decision — anchored rect + viewport + the menu's UNCAPPED content height (scrollHeight */
function computeMenuPlacement(
	rect: { top: number; bottom: number; left: number; right: number },
	viewport: { width: number; height: number },
	contentHeight: number,
	preferredSide: MenuSide,
	align: MenuAlign,
): MenuPlacement {
	const availDown = viewport.height - EDGE - (rect.bottom + GAP);
	const availUp = rect.top - GAP - EDGE;
	// contentHeight ≤ 0 (nothing measured yet) keeps the preferred side — the hidden first pass re-measures and decides with real numbers.
	let side = preferredSide;
	if (contentHeight > 0) {
		const preferredAvail = preferredSide === "down" ? availDown : availUp;
		const otherAvail = preferredSide === "down" ? availUp : availDown;
		if (contentHeight > preferredAvail && otherAvail > preferredAvail) {
			side = preferredSide === "down" ? "up" : "down";
		}
	}
	const avail = side === "down" ? availDown : availUp;
	const maxHeight = Math.max(MIN_USABLE, Math.min(CAP_VH * viewport.height, avail));
	const horizontal: Record<string, number> =
		align === "right" ? { right: viewport.width - rect.right } : { left: rect.left };
	const vertical: Record<string, number> =
		side === "down" ? { top: rect.bottom + GAP } : { bottom: viewport.height - rect.top + GAP };
	return { side, style: { ...horizontal, ...vertical }, maxHeight };
}

/** The shared shell. */
export function MenuShell({
	anchorRef,
	anchorTestid,
	testid,
	preferredSide,
	align = "right",
	menuClass,
	children,
}: {
	anchorRef?: RefObject<HTMLElement | null>;
	anchorTestid?: string;
	/** The menu body's own testid (sites assert it). */
	testid: string;
	/** Which way the menu opens from the anchor when both sides fit. */
	preferredSide: MenuSide;
	/** Which anchor edge the menu's horizontal position keys off. */
	align?: MenuAlign;
	/** The menu body classes: width, border, bg, padding, text — the shell adds position, z-index, the height cap, and scrolling. */
	menuClass: string;
	children: ReactNode;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [placed, setPlaced] = useState<MenuPlacement | null>(null);
	const focusedOnceRef = useRef(false);

	// Announce open↔close for lockable surfaces (see MENU_OPEN_EVENT).
	useEffect(() => {
		window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT));
		return () => {
			window.dispatchEvent(new CustomEvent(MENU_CLOSE_EVENT));
		};
	}, []);

	// Focus on open: the search menus land focus IN the search; menus without one land it on the body (tabIndex -1 below) so the arrow machine has a home.
	useEffect(() => {
		if (placed === null || focusedOnceRef.current) return;
		focusedOnceRef.current = true;
		const el = menuRef.current;
		if (!el) return;
		const input = el.querySelector<HTMLElement>("input");
		(input ?? el).focus();
	}, [placed]);

	// The standard arrow machine for menus WITHOUT a search: ArrowDown/Up move DOM focus among the option buttons with WRAP, Home/End hit the ends
	const onBodyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		const { key } = e;
		if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
		const buttons = Array.from(
			menuRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
		);
		if (buttons.length === 0) return;
		e.preventDefault();
		if (key === "Home") {
			buttons[0]?.focus();
			return;
		}
		if (key === "End") {
			buttons[buttons.length - 1]?.focus();
			return;
		}
		const delta = key === "ArrowDown" ? 1 : -1;
		const idx = buttons.findIndex((b) => b === document.activeElement);
		// From the body (nothing focused yet): ArrowDown enters at the FIRST option, ArrowUp at the last — the native-select convention.
		const base = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
		const next = (base + delta + buttons.length) % buttons.length;
		buttons[next]?.focus();
	};

	const anchor = () => {
		if (anchorRef) return anchorRef.current;
		if (anchorTestid !== undefined) return document.querySelector(`[data-testid="${anchorTestid}"]`);
		return null;
	};

	// Measure + (re)place: on mount, then on every capture-phase scroll and resize (rAF-throttled).
	useLayoutEffect(() => {
		let raf = 0;
		const place = () => {
			const el = anchor();
			if (!el || !menuRef.current) return;
			const p = computeMenuPlacement(
				el.getBoundingClientRect(),
				{ width: window.innerWidth, height: window.innerHeight },
				menuRef.current.scrollHeight,
				preferredSide,
				align,
			);
			setPlaced(p);
		};
		place();
		const rePlace = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(place);
		};
		window.addEventListener("scroll", rePlace, true);
		window.addEventListener("resize", rePlace);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", rePlace, true);
			window.removeEventListener("resize", rePlace);
		};
	}, [anchorRef, anchorTestid, preferredSide, align]);

	// First pass: mounted hidden at the viewport's top-left so the layout effect can measure the real content height before anything is seen.
	if (placed === null) {
		return createPortal(
			<div
				ref={menuRef}
				data-testid={testid}
				data-lh-menu=""
				style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
				className={menuClass}
			>
				{children}
			</div>,
			document.body,
		);
	}
	return createPortal(
		<div
			ref={menuRef}
			data-testid={testid}
			data-lh-menu=""
			tabIndex={-1}
			onKeyDown={onBodyKeyDown}
			style={{ position: "fixed", zIndex: 60, ...placed.style, maxHeight: placed.maxHeight, overflowY: "auto" }}
			// The body is the arrow machine's focus home (input-less menus land focus here on open) — the focus STAYS
			className={`${menuClass} outline-none`}
		>
			{children}
		</div>,
		document.body,
	);
}