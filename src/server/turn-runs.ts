/** The running-turn registry: chatId → the live PiTurnHandle. */

import type { PiTurnHandle } from "./pi/ui-stream.ts";

interface LhTurnRunsGlobal {
	__lhTurnRuns?: Map<string, PiTurnHandle>;
	__lhTurnFailures?: Map<string, string>;
}

function runs(): Map<string, PiTurnHandle> {
	const g = globalThis as typeof globalThis & LhTurnRunsGlobal;
	return (g.__lhTurnRuns ??= new Map<string, PiTurnHandle>());
}

/** One small, transient notice per failed session. */
function failures(): Map<string, string> {
	const g = globalThis as typeof globalThis & LhTurnRunsGlobal;
	return (g.__lhTurnFailures ??= new Map<string, string>());
}

export function rememberTurnFailure(chatId: string, errorText: string): void {
	failures().set(chatId, errorText);
}

export function turnFailure(chatId: string): string | undefined {
	return failures().get(chatId);
}

export function clearTurnFailure(chatId: string): void {
	failures().delete(chatId);
}

/** Register the chat's running turn (chat-handler, right after the turn starts). */
export function registerTurn(chatId: string, handle: PiTurnHandle): void {
	runs().set(chatId, handle);
}

/** Unregister at settle — chat-handler's onFinish, LAST (after endTurn). */
export function unregisterTurn(chatId: string): void {
	runs().delete(chatId);
}

/** The live turn handle for a chat, or undefined — the subscribe endpoint's and the abort channel's resolution point. */
export function runningTurn(chatId: string): PiTurnHandle | undefined {
	return runs().get(chatId);
}

/** The remote kill: any client (original sender, reattached viewer, future surfaces) may stop a running turn. */
export function abortTurn(chatId: string): { ok: true } | { ok: false; reason: "not_running" } {
	const handle = runs().get(chatId);
	if (!handle) return { ok: false, reason: "not_running" };
	handle.abort();
	return { ok: true };
}

/** The cheap terminal when GET /api/chats/[id]/stream finds no running turn (raced settle, or the client checked turnInFlight a beat too late) */
export function settledTurnResponse(chatId?: string): Response {
	const errorText = chatId ? turnFailure(chatId) : undefined;
	const notice = errorText === undefined ? "" : `data: ${JSON.stringify({ type: "error", errorText })}\n\n`;
	return new Response(`${notice}data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n`, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
