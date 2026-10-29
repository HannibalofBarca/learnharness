"use client";

import { useCallback, useEffect, useRef } from "react";
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import { messageAnchorId, messageIdFromHash } from "@/src/core";

export type SessionScrollContext = Pick<StickToBottomContext, "scrollRef" | "stopScroll">;

/** Scroll only the session's own containers (including tall question/code areas), never sidebar/chrome. */
export function scrollSessionTarget(target: Range | HTMLElement, scope: HTMLElement, context: SessionScrollContext | null): void {
	const node = "startContainer" in target ? target.startContainer : target;
	const main = context?.scrollRef.current;
	if (main?.contains(node)) context!.stopScroll();
	for (let element = node.parentElement; element && scope.contains(element); element = element.parentElement) {
		const view = element.ownerDocument.defaultView;
		const style = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(element) : null;
		if (element !== main && (!style || !/(auto|scroll)/.test(style.overflowY) || element.scrollHeight <= element.clientHeight)) continue;
		const rect = target.getBoundingClientRect();
		const container = element.getBoundingClientRect();
		element.scrollTo({ top: element.scrollTop + rect.top - container.top - 16, behavior: "instant" });
	}
}

/** React owns message markup; this controller adds no messages or content. */
export function SessionMessageNavigation() {
	const context = useStickToBottomContext();
	// ABSORB IDENTITY CHURN: use-stick-to-bottom re-creates stopScroll (and thus this context) while its initial scroll settles.
	const contextRef = useRef(context);
	contextRef.current = context;
	const lastJump = useRef<{ hash: string; target: HTMLElement } | null>(null);
	const flash = useRef<{ target: HTMLElement; timer: number } | null>(null);
	const clearFlash = useCallback(() => {
		if (!flash.current) return;
		window.clearTimeout(flash.current.timer);
		flash.current.target.classList.remove("lh-source-highlight");
		flash.current = null;
	}, []);
	/** Synchronous arrival: release the bottom-follow lock, scroll every session container so the passage sits near the top, flash it. */
	const jump = useCallback((): boolean => {
		const { scrollRef, stopScroll } = contextRef.current;
		const hash = window.location.hash;
		const messageId = messageIdFromHash(hash);
		const main = scrollRef.current;
		const target = messageId ? document.getElementById(messageAnchorId(messageId)) : null;
		if (!main || !target || !main.contains(target)) return false;
		if (lastJump.current?.hash === hash && lastJump.current.target === target) return true;
		stopScroll();
		scrollSessionTarget(target, main, { scrollRef, stopScroll });
		clearFlash();
		target.classList.add("lh-source-highlight");
		flash.current = { target, timer: window.setTimeout(clearFlash, 2_000) };
		lastJump.current = { hash, target };
		return true;
	}, [clearFlash]);

	// Arrival on mount (a graph link opened this session, or a full load carried the hash)
	useEffect(() => {
		if (!window.location.hash) return;
		let ticks = 0;
		const id = window.setInterval(() => {
			// Keep watching PAST the first success: hydration / record adoption can REPLACE the node that was just jumped to
			if (++ticks > 300) window.clearInterval(id);
			else jump();
		}, 64);
		return () => window.clearInterval(id);
	}, [jump]);

	useEffect(() => {
		const onHash = () => {
			lastJump.current = null;
			clearFlash();
			jump();
		};
		window.addEventListener("hashchange", onHash);
		window.addEventListener("popstate", onHash);
		// Cleanup removes LISTENERS ONLY: never clearFlash/lastJump here — a dep-churned re-run must not strip a live flash (see the note above).
		return () => {
			window.removeEventListener("hashchange", onHash);
			window.removeEventListener("popstate", onHash);
		};
	}, [jump, clearFlash]);
	return null;
}
