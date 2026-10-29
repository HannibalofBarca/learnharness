/** Server-side turn liveness: which chats currently have a teacher turn in flight. */

import { emit } from "../core/events.ts";
import { clearTurnFailure } from "./turn-runs.ts";

interface LhGlobal {
	__lhTurnRegistry?: Map<string, number>;
}

function registry(): Map<string, number> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnRegistry ??= new Map<string, number>());
}

const inFlight = registry();
const MAX_TURN_MS = 30 * 60_000;

/** Mark a turn as starting. */
export function beginTurn(chatId: string): boolean {
	if (isTurnRunning(chatId)) return false;
	clearTurnFailure(chatId);
	inFlight.set(chatId, Date.now());
	emit("turn-started", { chatId });
	return true;
}

/** Mark the chat's turn as finished after normal settlement, or after the failure notice has been retained by settlement cleanup. */
export function endTurn(chatId: string): void {
	if (inFlight.delete(chatId)) emit("turn-settled", { chatId });
}

/** True while the chat's turn is in flight; lazily evicts stale entries. */
export function isTurnRunning(chatId: string): boolean {
	const since = inFlight.get(chatId);
	if (since === undefined) return false;
	if (Date.now() - since > MAX_TURN_MS) {
		inFlight.delete(chatId);
		return false;
	}
	return true;
}
