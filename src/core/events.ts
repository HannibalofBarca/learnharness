/** THE EVENT BUS. */

/** The full event vocabulary — fixed from day one. */
export interface ServerEvents {
	/** A teach turn began server-side (beginTurn) — client-initiated sends, wake turns, other-tab turns: every origin rides the same event. */
	"turn-started": { chatId: string };
	/** A turn settled (endTurn — AFTER persistTurn, so any fetch triggered by this event reads a durable record */
	"turn-settled": { chatId: string };
	/** A job record changed (dispatch, progress, settle, abort, recovery). */
	"jobs-changed": { chatId?: string };
	/** An extraction run changed phase (activity dock). */
	"activity-changed": Record<string, never>;
	/** The session list changed (create, delete, title). */
	"chats-changed": Record<string, never>;
	/** Web subscription state changed. No account or credential data on the bus. */
	"subscriptions-changed": Record<string, never>;
	/** A chat's record changed WITHOUT a turn (the silent dismissal write). */
	"record-changed": { chatId: string };
	/** A compaction started/finished for the chat. */
	"compaction-changed": { chatId: string; running: boolean };
}

export type ServerEventType = keyof ServerEvents;

/** The vocabulary's runtime names — the client wires one listener per name (types are erased */
export const SERVER_EVENT_TYPES = [
	"turn-started",
	"turn-settled",
	"jobs-changed",
	"activity-changed",
	"chats-changed",
	"subscriptions-changed",
	"record-changed",
	"compaction-changed",
] as const satisfies readonly ServerEventType[];

/** One notification: the type discriminates the payload. */
export type ServerEvent<K extends ServerEventType = ServerEventType> = {
	type: K;
} & ServerEvents[K];

type ServerEventListener = (event: ServerEvent) => void;

interface LhEventsGlobal {
	__lhEventBus?: Set<ServerEventListener>;
}

/** The shared listener set — globalThis-backed so every Next module entry (and every layer) sees ONE bus. */
function listeners(): Set<ServerEventListener> {
	const g = globalThis as typeof globalThis & LhEventsGlobal;
	return (g.__lhEventBus ??= new Set());
}

/** Listen. */
export function subscribe(listener: ServerEventListener): () => void {
	const set = listeners();
	set.add(listener);
	return () => set.delete(listener);
}

/** Notify every listener. */
export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
	// Snapshot: a listener that unsubscribes (or subscribes) mid-emit must not mutate the set under iteration.
	for (const listener of [...listeners()]) {
		try {
			listener({ type, ...payload } as ServerEvent);
		} catch (err) {
			console.error(`[events] listener failed on ${type}:`, err);
		}
	}
}
