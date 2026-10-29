"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import type { ChatDeleteMode, ChatListItem } from "@/src/core";

/** The graph-traces checkbox copy: the graph-touching consequence says so, shared-topic survival included. */
const TRACES_COPY = {
	testid: "delete-traces",
	checkbox: "delete-traces-checkbox",
	title: "Also remove its graph traces",
	body: "This session’s topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only this session created are removed entirely.",
};

/** Session deletion — THE destructive-confirmation surface, portaled z-50 like the setup dialog */
export function DeleteSessionDialog({
	chat,
	onClose,
	onDeleted,
}: {
	/** The session up for deletion; null = closed. */
	chat: Pick<ChatListItem, "id" | "title"> | null;
	onClose: () => void;
	/** Success path — the sidebar owns navigation + list patching. */
	onDeleted: (id: string, mode: ChatDeleteMode, graphRevision: number) => void;
}) {
	const [traces, setTraces] = useState(false);
	const [busy, setBusy] = useState(false);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	// Retry IS pressing Delete again: the mode always derives from the checkbox's current state (a toggle between failure and retry is a change of intent
	const [failure, setFailure] = useState<{ code: string; error: string } | null>(null);

	// Fresh state per session: closing resets, opening a new chat starts clean.
	useEffect(() => {
		if (!chat) {
			setTraces(false);
			setBusy(false);
			setFailure(null);
		}
	}, [chat]);

	// Esc closes (claimed — a menu/dialog Esc must not also abort a turn).
	useEffect(() => {
		if (!chat) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW (keyboard round 2026-10-06): claim at the
				// document level — a window-level stopPropagation cannot stop
				// the earlier-registered global window listener.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [chat, onClose]);

	const run = async () => {
		if (!chat || busy) return;
		const mode: ChatDeleteMode = traces ? "delete-nodes" : "preserve-graph";
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/chats/${chat.id}?mode=${mode}`, { method: "DELETE" });
			const body = (await res.json()) as {
				ok?: boolean;
				error?: string;
				code?: string;
				graphRevision?: number;
			};
			if (!res.ok) {
				// 409 (turn/jobs running) and 503 (extraction winding down) are both retryable — keep the dialog open, show the server's line.
				setFailure({ code: body.code ?? "error", error: body.error ?? `Delete failed (${res.status})` });
				setBusy(false);
				return;
			}
			onDeleted(chat.id, mode, body.graphRevision ?? 0);
		} catch {
			setFailure({ code: "network", error: "Delete failed — network error. Try again." });
			setBusy(false);
		}
	};

	if (!chat) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			{...backdropDismiss}
		>
			<DeleteSessionBody
				chat={chat}
				traces={traces}
				busy={busy}
				failure={failure}
				onTraces={(next) => setTraces(next)}
				onClose={onClose}
				onRun={() => void run()}
			/>
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for SSR pins (the settings-dialog /
 *  node-dialog body pattern). The wrapper owns state + effects + portal. */
function DeleteSessionBody({
	chat,
	traces,
	busy,
	failure,
	onTraces,
	onClose,
	onRun,
}: {
	chat: Pick<ChatListItem, "id" | "title">;
	/** The graph-traces checkbox — unchecked by default (preserve-graph). */
	traces: boolean;
	busy: boolean;
	failure: { code: string; error: string } | null;
	onTraces: (next: boolean) => void;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete session"
			data-testid="delete-session-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">Delete session?</h2>
			{/* The session name below the title in JetBrains Mono: no code-block chrome — the font already says code. */}
			<div className="mt-1.5">
				<code data-testid="session-name-code" className="font-mono text-sm text-foreground">
					{chat.title}
				</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">
				This permanently removes the session — its messages, background jobs, and extraction records. Everything
				it added to the graph stays unless you check below. This cannot be undone.
			</p>
			<label
				data-testid={TRACES_COPY.testid}
				className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3"
			>
				<input
					type="checkbox"
					data-testid={TRACES_COPY.checkbox}
					checked={traces}
					onChange={(e) => onTraces(e.target.checked)}
					disabled={busy}
					className="mt-0.5 size-4 shrink-0 accent-primary"
				/>
				<span className="min-w-0">
					<span className="block text-sm text-foreground">{TRACES_COPY.title}</span>
					<span className="mt-1 block text-xs text-muted-foreground">{TRACES_COPY.body}</span>
				</span>
			</label>
			{failure && (
				<div
					role="alert"
					data-testid="delete-failure"
					className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs"
				>
					<span className="text-foreground">{failure.error}</span>
					<button
						type="button"
						data-testid="delete-retry"
						onClick={onRun}
						disabled={busy}
						className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
					>
						Try again
					</button>
				</div>
			)}
			{/* The node dialog's exact bottom row: quiet Cancel, destructive red Delete (border + text, fill on hover — the app's established destructive pair). */}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="delete-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-confirm"
					onClick={onRun}
					disabled={busy}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					{busy ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	);
}