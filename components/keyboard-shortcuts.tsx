"use client";

/** Keyboard shortcuts — the single document-level keydown listener. */

import { useEffect, useRef, useState } from "react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useRouter } from "next/navigation";
import {
	actionForBinding,
	bindingForAction,
	eventBinding,
	formatBinding,
	isTypingSurface,
	kbdEventForAction,
	KEYBOARD_ACTIONS,
} from "@/src/core";
import { isDictationActive } from "@/components/dictation";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";

export function KeyboardShortcuts() {
	const router = useRouter();
	const [cheatOpen, setCheatOpen] = useState(false);
	const { open: openSettings } = useSettingsDialog();

	// Router + cheat + settings state inside a ref so the keydown listener (attached once) never goes stale.
	const handlersRef = useRef<{
		router: ReturnType<typeof useRouter>;
		setCheatOpen: (v: boolean) => void;
		openSettings: () => void;
	}>({ router, setCheatOpen, openSettings });
	handlersRef.current = { router, setCheatOpen, openSettings };

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			// ── Tab is dead: preventDefault even when nothing is bound to it — browser tab-focus is abandoned, and the default action runs after dispatch
			if (e.key === "Tab") {
				e.preventDefault();
				if (e.shiftKey) window.dispatchEvent(new CustomEvent("lh:kbd-cycle-thinking"));
				// Plain Tab cycles the active surface's text fields — forward-only, wrapping; each composer-bearing page answers with its own chain.
				else if (!e.metaKey && !e.ctrlKey && !e.altKey)
					window.dispatchEvent(new CustomEvent("lh:kbd-cycle-fields"));
				return;
			}

			if (e.key === "Escape") {
				// Our own overlay is the topmost layer.
				if (cheatOpen) {
					setCheatOpen(false);
					e.preventDefault();
					return;
				}
				// THE ONE-ESC LAW: one Esc, one action, on the topmost active layer.
				if (isDictationActive()) {
					e.preventDefault();
					window.dispatchEvent(new CustomEvent("lh:kbd-cancel-dictation"));
					return;
				}
				window.dispatchEvent(new CustomEvent("lh:kbd-abort-turn"));
				return;
			}

			// ── Registry dispatch.
			const action = actionForBinding(eventBinding(e));
			if (!action) return;

			// The input guard: inside a typing surface only mod/alt combos fire (they never type a character).
			if (isTypingSurface(e) && !(e.metaKey || e.ctrlKey || e.altKey)) return;

			// Dispatch: global commands we own run here; surface commands
			// ride the window event for the mounted surface to catch.
			switch (action) {
				case "new-session":
					handlersRef.current.router.push("/chat/new");
					break;
				case "open-settings":
					// Settings-app wave: the dialog is the surface, the URL is gone — /settings redirects to the draft shell.
					handlersRef.current.openSettings();
					break;
				case "jump-graph":
					handlersRef.current.router.push("/");
					break;
				case "cheat-sheet":
					handlersRef.current.setCheatOpen(true);
					break;
				case "find":
					// The mounted surface owns Find (session text / graph nodes).
					e.preventDefault();
					window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
					break;
				default:
					window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [cheatOpen]);

	return <CheatSheet open={cheatOpen} onClose={() => setCheatOpen(false)} />;
}

/** The ? */
function CheatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	const backdropDismiss = useBackdropDismiss(onClose);
	if (!open) return null;
	const scopes = ["global", "chat", "graph"] as const;
	const scopeLabels: Record<(typeof scopes)[number], string> = {
		global: "Global",
		chat: "Chat",
		graph: "Graph view",
	};
	return (
		<div
			data-testid="cheat-sheet"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			{...backdropDismiss}
		>
			<div
				className="max-h-[80vh] w-full max-w-[36rem] overflow-y-auto rounded-xl border bg-card p-5 shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mb-4 flex items-baseline justify-between">
					<span className="text-sm font-medium text-card-foreground">Keyboard shortcuts</span>
					<span className="text-xs text-muted-foreground">Esc to close</span>
				</div>
				{scopes.map((scope) => {
					const actions = KEYBOARD_ACTIONS.filter((a) => a.scope === scope);
					if (actions.length === 0) return null;
					return (
						<div key={scope} className="mb-4">
							<div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">
								{scopeLabels[scope]}
							</div>
							<div className="flex flex-col gap-1">
								{actions.map((a) => (
									<div key={a.id} className="flex items-center justify-between gap-4 text-sm">
										<span className="text-muted-foreground">{a.label}</span>
										<kbd className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-card-foreground">
											{formatBinding(bindingForAction(a.id))}
										</kbd>
									</div>
								))}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
