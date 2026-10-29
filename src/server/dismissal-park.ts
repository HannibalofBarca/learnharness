/** PARKED DISMISSALS: ESC-discard while the turn is still working. */

import { ChatInputError, dismissAppends, emit } from "../core";
import type { ChatStore } from "../core/ports.ts";

/** The parked dismissal body — exactly the parsed input the dismiss route accepted ({type:"dismiss", toolCallId, answer} or {type:"dismiss-problem" */
type ParkedDismissal = unknown;

interface LhGlobal {
	__lhParkedDismissals?: Map<string, ParkedDismissal>;
}

function registry(): Map<string, ParkedDismissal> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhParkedDismissals ??= new Map<string, ParkedDismissal>());
}

/** Park (or overwrite) the chat's dismissal intent. */
export function parkDismissal(chatId: string, input: ParkedDismissal): void {
	registry().set(chatId, input);
}

/** Take the chat's parked dismissal (removes it). */
export function takeParkedDismissal(chatId: string): ParkedDismissal | null {
	const parked = registry().get(chatId);
	if (parked === undefined) return null;
	registry().delete(chatId);
	return parked;
}

/** Apply the chat's parked dismissal, if any, against the current record. */
export function applyParkedDismissal(chatStore: ChatStore, chatId: string): void {
	const input = takeParkedDismissal(chatId);
	if (input === null) return;
	const record = chatStore.getChat(chatId);
	if (!record) return;
	try {
		const appends = dismissAppends(record, input as Parameters<typeof dismissAppends>[1]);
		chatStore.saveMessages(chatId, [...record.messages, ...appends]);
		emit("record-changed", { chatId });
	} catch (err) {
		if (err instanceof ChatInputError) return; // never materialized — drop
		throw err;
	}
}
