import type { AgentEvent, AgentMessage } from "../../core/agent-types.ts";

/** What the turn runner drives: the bridge's BridgeAgent (src/server/claude/session.ts) — state, events, run-to-settle, abort. */
export interface TurnAgent {
	state: { messages: AgentMessage[] };
	subscribe(listener: (event: AgentEvent) => void): unknown;
	continue(): Promise<void>;
	abort(): void;
}
import { ToolCallIdUniquifier } from "./call-ids.ts";

/** THE NATIVE WIRE: one agent turn, streamed to every view as pi AgentEvents — no translation, no part assembly. */

/** The wire event: a pi AgentEvent (with our slim message_update — see the WIRE DIET note above), or one of the two app events. */
type TurnWireEvent =
	| AgentEvent
	| { type: "message_update"; message: AgentMessage }
	| { type: "error"; errorText: string };

interface PiTurnSpec {
	/** The per-turn agent (stateless engine — built from the record). */
	agent: TurnAgent;
	/** The handler's error-masking policy for LOOP-level failures (the event stream itself is verbatim */
	onError?: (error: unknown) => string;
	/** Report settlement failure while the views are still open. */
	onSettleError?: (error: unknown) => string;
	/** Release liveness even if the normal finish seam throws. */
	onSettleFailure?: (error: unknown, reportedErrorText?: string) => void;
	/** The canonical end-of-turn seam: persist + usage + extraction + endTurn. */
	onFinish: (messages: AgentMessage[], isAborted: boolean) => void;
	/** Tool-call ids already used in this chat's record: when present, a ToolCallIdUniquifier sits at this boundary */
	usedToolCallIds?: ReadonlySet<string>;
	/** The coalescing window for update fan-out (COMPACTION LAW above). */
	updateFlushMs?: number;
}

/** One view onto a running turn: push() replays/streams an event, done() terminates the view ([DONE] + close). */
interface PiTurnSubscriber {
	push(event: TurnWireEvent): void;
	done(): void;
}

/** The server-side turn object: runs the agent decoupled from any single HTTP response and owns the in-memory event log + the live subscriber set. */
export interface PiTurnHandle {
	/** A fresh subscriber stream: FULL replay of the log, then live events until the turn settles (ending [DONE]). */
	subscribe(): ReadableStream<Uint8Array>;
	/** The remote kill — the ONLY way a running turn dies early: sawAbort + agent.abort() */
	abort(): void;
}

export function runPiTurn(spec: PiTurnSpec): PiTurnHandle {
	const { agent, onError, onFinish, onSettleError, onSettleFailure, usedToolCallIds, updateFlushMs = 100 } = spec;
	const uniquifier = usedToolCallIds ? new ToolCallIdUniquifier(usedToolCallIds) : undefined;

	let settled = false;
	let sawAbort = false;
	let reportedErrorText: string | undefined;

	// THE PER-TURN STATE LOG (memory-only — the settle-only disk writes are unchanged).
	const log: TurnWireEvent[] = [];
	// Live-update slots: coalesce key → log index of the retained update.
	const updateSlots = new Map<string, number>();
	// The coalescing queue for LIVE fan-out: key → latest event, flushed at most once per flush window (Map preserves first-insertion order
	const pending = new Map<string, TurnWireEvent>();
	const subscribers = new Set<PiTurnSubscriber>();

	const coalesceKey = (event: TurnWireEvent): string | null => {
		if (event.type === "message_update") return "message";
		if (event.type === "tool_execution_update") return `tool:${event.toolCallId}`;
		return null;
	};

	// Send = compact the log + fan out to every live view.
	const send = (event: TurnWireEvent) => {
		if (settled) return;
		const key = coalesceKey(event);
		if (key !== null) {
			// Retention: replace-in-place the run's latest snapshot.
			const idx = updateSlots.get(key);
			if (idx !== undefined) log[idx] = event;
			else {
				updateSlots.set(key, log.length);
				log.push(event);
			}
			// Fan-out: coalesced — latest wins, flushed at ≤1/window.
			pending.set(key, event);
			armFlush();
			return;
		}
		// A boundary event ends its update run.
		if (event.type === "message_end") updateSlots.delete("message");
		if (event.type === "tool_execution_end") updateSlots.delete(`tool:${event.toolCallId}`);
		// Strict per-subscriber ordering: anything still pending precedes this boundary event on the wire, never after it.
		flushPending();
		log.push(event);
		for (const sub of subscribers) sub.push(event);
	};

	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const flushPending = () => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (pending.size === 0) return;
		const batch = [...pending.values()];
		pending.clear();
		for (const sub of subscribers) for (const event of batch) sub.push(event);
	};
	const armFlush = () => {
		if (flushTimer !== undefined) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flushPending();
		}, updateFlushMs);
		// Never holds the process (or the test runner) open for a straggler.
		(flushTimer as { unref?: () => void }).unref?.();
	};
	const closeAll = () => {
		if (settled) return;
		// Order to the very end: the last pending snapshot precedes [DONE].
		flushPending();
		settled = true;
		for (const sub of subscribers) sub.done();
		subscribers.clear();
	};
	// The settle seam: the record write is the agent's OWN final state (native history — signatures, usage, provider stamps all real).
	const settleWith = () => {
		try {
			const settled_ = [...agent.state.messages].filter((m) => (m as { role?: string }).role !== "system");
			onFinish((uniquifier?.remapSettled(settled_) as AgentMessage[]) ?? settled_, sawAbort);
		} catch (err) {
			console.error("[turn] settlement failed:", err);
			try { onSettleFailure?.(err, reportedErrorText); }
			catch (cleanupError) { console.error("[turn] settlement cleanup failed:", cleanupError); }
			if (reportedErrorText === undefined) {
				reportedErrorText = onSettleError?.(err) ?? "An error occurred.";
				send({ type: "error", errorText: reportedErrorText });
			}
		}
	};

	const handle = (event: AgentEvent) => {
		if (settled) return;
		// THE LACAN FIX: ids uniquify HERE, before any view — the one seam every consumer downstream shares.
		const uniqued = uniquifier ? uniquifier.event(event) : event;
		// WIRE DIET: slim the one event pi double-stuffs — our views read `message`, never `assistantMessageEvent` (same full partial twice).
		const wire: TurnWireEvent =
			uniqued.type === "message_update"
				? { type: "message_update", message: uniqued.message }
				: uniqued;
		send(wire);
		if (event.type === "message_end") {
			const m = event.message as { role?: string; stopReason?: string } | undefined;
			if (m?.role === "assistant" && m.stopReason === "aborted") sawAbort = true;
		}
		if (event.type === "agent_end") {
			// Persist/report before the terminal closes every view to new frames.
			settleWith();
			closeAll();
		}
	};
	agent.subscribe(handle);

	void (async () => {
		try {
			await agent.continue();
		} catch (err) {
			// A loop-level failure (not a provider error — those ride the stream as stopReason "error"): surface, close, persist.
			if (settled) {
				console.error("[turn] error after settlement:", err);
				return;
			}
			console.error("[turn] agent loop failed:", err);
			reportedErrorText = onError?.(err) ?? "An error occurred.";
			send({ type: "error", errorText: reportedErrorText });
			settleWith();
			closeAll();
		}
	})();

	return {
		subscribe() {
			let sub: PiTurnSubscriber | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let closed = false;
					sub = {
						push(event) {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							} catch {
								/* reader cancelled — stop emitting, keep running */
								closed = true;
							}
						},
						done() {
							if (closed) return;
							closed = true;
							try {
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							} catch {
								/* already cancelled */
							}
						},
					};
					// Attach THEN replay — synchronous, so no event can fall between replay and live (single-threaded
					subscribers.add(sub);
					for (const event of log) sub.push(event);
					// A subscriber that attached after settle (the unregister race) still gets the full history + [DONE].
					if (settled) sub.done();
				},
				cancel() {
					// THE OWNER RULING: a view leaving NEVER kills the turn — only the explicit abort channel does.
					if (sub) subscribers.delete(sub);
				},
			});
			return stream;
		},
		abort() {
			if (settled) return;
			sawAbort = true;
			agent.abort();
		},
	};
}

/** The subscriber-shaped SSE response — the POST /api/chat response and GET /api/chats/[id]/stream are BOTH this: same headers, same wire dialect */
export function piTurnResponse(handle: PiTurnHandle): Response {
	return new Response(handle.subscribe(), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
