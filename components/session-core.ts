/** THE SESSION MODEL: the chat session's state machine, extracted PURE — no React, one injectable fetch */

import type { AgentEvent } from "@/src/core";
import type { ToolResultMessage } from "@/src/core";
import {
	needsContinuation,
	danglingQuestionOf,
	answeredCallIds,
	measuredContextTokens,
	newAnswerResult,
	newNextMessage,
	newProblemDismissedMarker,
	newThinkingMessage,
	newUserMessage,
	projectView,
	type ChatInput,
	type LhMarkerMessage,
	type LhMessage,
	type LhViewMessage,
	type LiveExecution,
	type QuestionAnswerData,
	type QuestionDraft,
} from "../src/core";

export type SessionStatus = "ready" | "submitted" | "streaming" | "error";

/** How often to poll turnInFlight while a racing turn runs (409 retry). */
const TURN_POLL_MS = 500;
/** Give up waiting (a wake turn can run long) and surface the 409. */
const TURN_WAIT_MAX_MS = 30_000;

interface SessionModelDeps {
	/** Injectable fetch (tests); defaults to the global. */
	fetch?: typeof globalThis.fetch;
	/** Injectable retry timing (tests). */
	pollMs?: number;
	waitMaxMs?: number;
}

/** A local optimistic id (never a server stamp — absorption and the settle swap both key on this prefix). */
let localSeq = 0;
function localId(): string {
	return `c_${Date.now().toString(36)}_${(localSeq++).toString(36)}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

async function turnInFlight(model: SessionModel): Promise<boolean | null> {
	try {
		const res = await model.fetch(`/api/jobs?chatId=${encodeURIComponent(model.chatId)}`);
		if (!res.ok) return null;
		return ((await res.json()) as { turnInFlight?: boolean }).turnInFlight === true;
	} catch {
		return null; // network hiccup: keep waiting, the deadline bounds us
	}
}

const STREAM_DROPPED = "The connection dropped before the turn completed.";

/** Mark transport failures without confusing JSON/application bugs with drops. */
class StreamReadError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}

/** Wire events; return true ONLY for the explicit completion marker. */
async function* sseEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Record<string, unknown>, boolean> {
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		let chunk: ReadableStreamReadResult<Uint8Array>;
		try { chunk = await reader.read(); }
		catch (err) { throw new StreamReadError(err); }
		const { done, value } = chunk;
		if (done) return false;
		buf += decoder.decode(value, { stream: true });
		for (;;) {
			const end = buf.indexOf("\n\n");
			if (end === -1) break;
			const event = buf.slice(0, end);
			buf = buf.slice(end + 2);
			const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
			if (!dataLine) continue;
			const data = dataLine.slice("data: ".length);
			if (data === "[DONE]") return true;
			yield JSON.parse(data) as Record<string, unknown>;
		}
	}
}

/** The dangling question call's tool name (the optimistic answer result's toolName — the server stamps the same from its own record scan). */
function pendingCallTool(messages: readonly LhMessage[], toolCallId: string): string | null {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
			if (block.type === "toolCall" && block.id === toolCallId) return block.name ?? null;
		}
	}
	return null;
}

/** Has the record ABSORBED this optimistic tail entry? */
function absorbed(m: LhMessage, record: readonly LhMessage[]): boolean {
	if (typeof m.id !== "string" || !m.id.startsWith("c_")) return false;
	const role = (m as { role?: string }).role;
	if (role === "user") {
		const content = (m as { content?: unknown }).content;
		return record.some(
			(r) => (r as { role?: string }).role === "user" && (r as { content?: unknown }).content === content,
		);
	}
	if (role === "toolResult") {
		const toolCallId = (m as ToolResultMessage).toolCallId;
		return record.some(
			(r) =>
				(r as { role?: string }).role === "toolResult" &&
				(r as ToolResultMessage).toolCallId === toolCallId,
		);
	}
	if (role === "custom") {
		// Markers.
		const marker = m as LhMarkerMessage;
		return record.some(
			(r) =>
				(r as { role?: string }).role === "custom" &&
				(r as LhMarkerMessage).customType === marker.customType &&
				sameDetails((r as LhMarkerMessage).details, marker.details),
		);
	}
	return false;
}

/** Structural deep-equal for marker details (JSON-stable payloads — the constructors mint plain data). */
function sameDetails(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export interface SessionState {
	messages: LhViewMessage[];
	nativeMessages: LhMessage[];
	/** Completed conversation usage; null after compaction or before first usage. */
	contextTokens: number | null;
	status: SessionStatus;
	error: { message: string } | null;
	/** Steers sent but not yet drained: the queued indicator's truth. */
	steerQueue: SteerQueueItem[];
}

/** One queued composer steer: the client-minted id (the upsert key) + text. */
export interface SteerQueueItem {
	id: string;
	text: string;
}

/** The indicator's fold (pure): a queued steer stays visible until its id lands in the message list — from the live stream's upsert, the settle sync */
export function visibleQueuedSteers(
	queue: readonly SteerQueueItem[],
	messages: readonly LhMessage[],
): SteerQueueItem[] {
	const ids = new Set(messages.map((m) => (m as { id?: string }).id));
	return queue.filter((s) => !ids.has(s.id));
}

interface SessionModelOptions extends SessionModelDeps {
	chatId: string;
	initialMessages: LhMessage[];
	/** Retained, memory-only server failure when reopening a session. */
	initialError?: string;
	/** Fires on every state change (the hook re-renders). */
	onChange?: () => void;
	/** The reattach settled terminal (turn-settled): no turn running, the record is current — the caller refetches it. */
	onReattachSettled?: () => void;
}

export class SessionModel {
	readonly chatId: string;
	/** Injectable fetch (tests); defaults to the global. */
	fetch: typeof globalThis.fetch;
	/** Steers sent but not yet drained (the queued indicator's truth). */
	private steerQueueValue: SteerQueueItem[] = [];
	private readonly pollMs: number;
	private readonly waitMaxMs: number;
	private onReattachSettled?: () => void;
	/** The hook's re-render trigger (set by the adapter). */
	onChange?: () => void;

	// THE STATE: the record (server canon) + the live tail (this client's optimistic appends and the streaming turn's messages).
	private base: LhMessage[];
	private tail: LhMessage[] = [];
	private questionDrafts = new Map<string, QuestionDraft>();
	/** Only learner answers submitted through send(), never silent dismissals. */
	private unconfirmedAnswers = new Map<string, string>();
	// The live turn's execution layer (view model mid-turn states):
	private executions = new Map<string, LiveExecution>();
	private streamingIds = new Set<string>();
	private incompleteUsageIds = new Set<string>();
	/** The in-flight assistant message's client id (see applyWireEvent). */
	private streamingMessageId: string | null = null;
	private statusValue: SessionStatus = "ready";
	/** Request/loop failures are transient; provider failures derive from messages. */
	private errorValue: { message: string } | null = null;
	/** Dismissing a banner must not authorize an automatic replacement turn. */
	private automaticContinuationBlocked = false;
	/** A completed failure from THIS consume, not the previous attempt's record. */
	private liveFailureId: string | null = null;
	// The single live consume (POST response or reattach stream): a newer consume cancels the older — one reader at a time.
	private consumeAbort: AbortController | null = null;
	/** Synchronous ready check for the gate (send/read mount logic). */
	readyRef = true;

	constructor(opts: SessionModelOptions) {
		this.chatId = opts.chatId;
		this.base = opts.initialMessages;
		this.errorValue = opts.initialError === undefined ? null : { message: opts.initialError };
		this.automaticContinuationBlocked = opts.initialError !== undefined;
		// BOUND: the browser's native fetch is a Window method
		this.fetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
		this.pollMs = opts.pollMs ?? TURN_POLL_MS;
		this.waitMaxMs = opts.waitMaxMs ?? TURN_WAIT_MAX_MS;
		this.onChange = opts.onChange;
		this.onReattachSettled = opts.onReattachSettled;
	}

	/** Injectable settle hook (the adapter wires its ref). */
	setReattachSettled(fn: () => void): void {
		this.onReattachSettled = fn;
	}

	getState(): SessionState {
		const live =
			this.statusValue === "submitted" || this.statusValue === "streaming"
				? { executions: this.executions, inFlight: true, streamingIds: this.streamingIds }
				: undefined;
		const messages = [...this.base, ...this.tail];
		const latest = messages.at(-1);
		// One rule for live and restored failures: only the final completed assistant can own the banner.
		const providerError =
			latest?.role === "assistant" && latest.stopReason === "error" &&
			!this.incompleteUsageIds.has(latest.id) && (!live || latest.id === this.liveFailureId)
				? { message: latest.errorMessage ?? "An error occurred." }
				: null;
		return {
			messages: projectView(messages, live),
			nativeMessages: messages,
			contextTokens: measuredContextTokens(messages, this.incompleteUsageIds),
			status: this.statusValue,
			error: this.errorValue ?? providerError,
			steerQueue: this.steerQueueValue,
		};
	}

	get status(): SessionStatus {
		return this.statusValue;
	}

	/** Mutate model state + notify (the hook re-renders). */
	private mutate(fn: () => void): void {
		fn();
		this.onChange?.();
	}

	private setStatus(status: SessionStatus): void {
		if (status === "submitted") this.liveFailureId = null;
		this.statusValue = status;
		this.readyRef = status === "ready";
		this.onChange?.();
	}

	private setError(message: string | null): void {
		this.errorValue = message === null ? null : { message };
		if (message !== null) this.automaticContinuationBlocked = true;
		this.onChange?.();
	}

	/** The 409 identity-retry fetch: the event was never persisted (write-ahead happens only on acceptance) */
	async postInputEvent(input: ChatInput, signal?: AbortSignal): Promise<Response> {
		const body = JSON.stringify({ chatId: this.chatId, input });
		const init: RequestInit = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal,
		};
		let response = await this.fetch("/api/chat", init);
		let waited = 0;
		while (response.status === 409) {
			await response.body?.cancel().catch(() => {});
			if (signal?.aborted || waited >= this.waitMaxMs) return response;
			await delay(this.pollMs, signal);
			waited += this.pollMs;
			if (signal?.aborted) return response;
			if ((await turnInFlight(this)) !== false) continue;
			response = await this.fetch("/api/chat", init); // may 409 again → loop
		}
		return response;
	}

	/** ONE event application for both the POST stream and the reattach replay (pi's events carry the FULL partial message — a view REPLACES */
	applyWireEvent(event: Record<string, unknown>): boolean {
		if (event.type === "error") {
			// Loop-level failure (agent.continue threw outside the stream) — raw text: the banner shows exactly this.
			this.setError(String(event.errorText ?? "An error occurred."));
			return false;
		}
		const agent = event as unknown as AgentEvent;
		switch (agent.type) {
			case "agent_start":
				// Positive evidence of a new/replayed server-owned turn.
				this.automaticContinuationBlocked = false;
				if (this.errorValue !== null) this.setError(null);
				return false;
			case "message_start":
			case "message_update":
			case "message_end": {
				const message = agent.message as LhMessage & {
					role?: string;
					id?: string;
				};
				if ((message as { role?: string }).role !== "assistant") {
					// Wave C: markers injected mid-run arrive as custom-role message_start/message_end events - UPSERT by id (markers always carry steer_<id> ids
					const mid = message.id;
					if (mid === undefined) return false;
					this.mutate(() => {
						const idx = this.tail.findIndex((m) => m.id === mid);
						this.tail =
							idx === -1 ? [...this.tail, message as LhMessage] : this.tail.with(idx, message as LhMessage);
					});
					return true;
				}
				// pi streams AssistantMessages with NO id — the id exists only once the server's persistTurn stamps the record.
				const id = message.id ?? this.streamingMessageId ?? localId();
				const withId = { ...message, id } as LhMessage;
				if (agent.type === "message_end") {
					this.incompleteUsageIds.delete(id);
					if (message.role === "assistant" && message.stopReason === "error") {
						this.liveFailureId = id;
						// A newer provider failure replaces an earlier connection/loop error, just as the live message_end did before restoration.
						this.errorValue = null;
					}
				} else this.incompleteUsageIds.add(id);
				if (agent.type === "message_start") {
					this.streamingMessageId = id;
					this.streamingIds.add(id);
					this.mutate(() => {
						this.tail = [...this.tail, withId];
					});
				} else {
					this.mutate(() => {
						const idx = this.tail.findIndex((m) => m.id === id);
						this.tail = idx === -1 ? [...this.tail, withId] : this.tail.with(idx, withId);
					});
				}
				if (agent.type === "message_end") {
					this.streamingMessageId = null; // slot done — next start mints fresh
				}
				return true; // a message event is view work, even empty content
			}
			case "tool_execution_end": {
				// The execution layer: clean question placeholders are IGNORED downstream (view.ts fork 2); errors keep their validation text.
				const result = agent.result as
					| { content?: Array<{ type?: string; text?: string }>; details?: unknown }
					| null;
				const text = result?.content?.find((c) => c.type === "text")?.text ?? "The tool call failed.";
				this.mutate(() => {
					this.executions = new Map(this.executions).set(agent.toolCallId, {
						isError: agent.isError,
						output: result?.details,
						errorText: text,
					});
				});
				return true; // the execution layer updated the tool part's card
			}
			case "turn_end": {
				// The results batch: append as native messages (client-stamped ids — the settle sync lands the server canon).
				this.mutate(() => {
					this.tail = [
						...this.tail,
						...(agent.toolResults as ToolResultMessage[]).map(
							(r) => ({ ...r, id: localId() }) as unknown as LhMessage,
						),
					];
				});
				return true;
			}
			default:
				return false; // agent_start/turn_start/tool_execution_start|update: no view work
		}
	}

	/** Consume one SSE body to its [DONE] terminal. */
	async consumeStream(res: Response, controller = this.consumeAbort, allowRecovery = true): Promise<void> {
		if (!res.body) throw new Error("The turn stream body is empty.");
		const reader = res.body.getReader();
		let sawEvent = false;
		let sawDone = false;
		try {
			const events = sseEvents(reader);
			for (;;) {
				let next: IteratorResult<Record<string, unknown>, boolean>;
				try { next = await events.next(); }
				catch (err) {
					if (err instanceof StreamReadError) break;
					throw err;
				}
				if (this.consumeAbort !== controller) return;
				if (next.done) { sawDone = next.value; break; }
				const event = next.value;
				if (event.type === "turn-settled") {
					// The raced-settle terminal: no turn to attach to — the record is current; the settle hook refetches.
					sawDone = true;
					this.onReattachSettled?.();
					return;
				}
				const acted = this.applyWireEvent(event);
				if (!sawEvent && acted) {
					sawEvent = true;
					if (this.statusValue !== "error") this.setStatus("streaming");
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
			// A cancelled consume may finish after its replacement has entered Thinking.
			if (this.consumeAbort === controller) {
				this.streamingIds = new Set();
				this.executions = new Map();
				if (sawDone && this.statusValue !== "error") this.setStatus("ready");
			}
		}
		if (this.consumeAbort !== controller || sawDone) return;
		if (!allowRecovery) throw new StreamReadError(new Error(STREAM_DROPPED));
		// One read-only recovery: refresh the canonical base, then replay the SAME server-owned turn.
		await this.resumeStream(true, false);
	}

	private async fetchView(url: string, signal: AbortSignal, recoveringDrop: boolean): Promise<Response> {
		try {
			const res = await this.fetch(url, { signal });
			if (recoveringDrop && !res.ok) throw new Error((await res.text()) || STREAM_DROPPED);
			return res;
		} catch (err) {
			if (recoveringDrop && !signal.aborted) throw new StreamReadError(err);
			throw err;
		}
	}

	/** Reattach (the wake/handoff/mount path): a server-side turn with no live view of ours. */
	async resumeStream(refetchRecordFirst = true, allowRecovery = true): Promise<void> {
		this.consumeAbort?.abort();
		const controller = new AbortController();
		this.consumeAbort = controller;
		// REPLAY ONTO A CLEAN SLATE: the reattach stream replays the turn from its FIRST event
		if (!refetchRecordFirst) {
			this.mutate(() => {
				this.incompleteUsageIds.clear();
				this.tail = [];
				this.streamingMessageId = null;
			});
		}
		this.setStatus("submitted");
		try {
			if (refetchRecordFirst) {
				const recordRes = await this.fetchView(`/api/chats/${encodeURIComponent(this.chatId)}`, controller.signal, !allowRecovery);
				if (this.consumeAbort !== controller) return;
				if (recordRes.ok) {
					let text: string;
					try { text = await recordRes.text(); }
					catch (err) {
						if (!allowRecovery && !controller.signal.aborted) throw new StreamReadError(err);
						throw err;
					}
					// Parse outside the transport catch: malformed JSON is a contract bug, not a connection-drop diagnostic.
					const record = JSON.parse(text) as { messages?: LhMessage[]; turnError?: string };
					if (this.consumeAbort !== controller) return;
					if (Array.isArray(record.messages)) {
						this.mutate(() => {
							this.base = record.messages!;
							if (record.turnError !== undefined) {
								this.errorValue = { message: record.turnError };
								this.automaticContinuationBlocked = true;
							}
							this.forgetResolvedDrafts(record.messages!);
							this.incompleteUsageIds.clear();
							this.tail = [];
						});
					}
				} else {
					// The record did not land — restore the clean-slate guard before the replay (no atomic swap is coming).
					this.mutate(() => {
						this.incompleteUsageIds.clear();
						this.tail = [];
						this.streamingMessageId = null;
					});
				}
			}
			const res = await this.fetchView(`/api/chats/${encodeURIComponent(this.chatId)}/stream`, controller.signal, !allowRecovery);
			if (this.consumeAbort !== controller) return;
			if (!res.ok) throw new Error((await res.text()) || "Failed to attach to the running turn.");
			await this.consumeStream(res, controller, allowRecovery);
		} catch (err) {
			if (this.consumeAbort !== controller || controller.signal.aborted) return; // intentionally cancelled
			// A failed record read can leave the optimistic answer in the tail.
			this.mutate(() => {
				this.tail = this.tail.filter(m => !this.unconfirmedAnswers.has(m.id));
				this.unconfirmedAnswers.clear();
			});
			this.setError(!allowRecovery && err instanceof StreamReadError ? STREAM_DROPPED : (err as Error).message);
			this.setStatus("error");
		}
	}

	/** SEND: one explicit input event. */
	async send(input: ChatInput): Promise<void> {
		const recovering = this.statusValue === "error";
		if (!this.readyRef && !recovering) return;
		this.consumeAbort?.abort();
		const controller = new AbortController();
		this.consumeAbort = controller;
		this.setError(null);
		this.setStatus("submitted");
		if (recovering && input.type === "answer") {
			try {
				const res = await this.fetch(`/api/chats/${encodeURIComponent(this.chatId)}`, { signal: controller.signal });
				if (this.consumeAbort !== controller) return;
				if (!res.ok) throw new Error((await res.text()) || "An error occurred.");
				const record = await res.json() as { messages?: LhMessage[]; turnInFlight?: boolean; turnError?: string };
				if (this.consumeAbort !== controller) return;
				// No verified record/liveness: retain the draft and never guess whether a lost acknowledgement meant the input was accepted.
				if (!Array.isArray(record.messages) || typeof record.turnInFlight !== "boolean") throw new Error("An error occurred.");
				this.setMessages(record.messages, record.turnError);
				if (record.turnInFlight) {
					await this.resumeStream(false);
					return;
				}
				if (input.type === "answer" && (answeredCallIds(record.messages).has(input.toolCallId) || danglingQuestionOf(record.messages)?.toolCallId !== input.toolCallId)) {
					// The call already resolved, or no longer owns the dock.
					this.setStatus("ready");
					return;
				}
			} catch (err) {
				if (this.consumeAbort !== controller || controller.signal.aborted) return;
				this.setError((err as Error).message);
				this.setStatus("error");
				return;
			}
		}
		if (input.type !== "continue") this.automaticContinuationBlocked = false;
		// The optimistic appends — exactly the messages the server's write-ahead will persist (inputAppends)
		const optimistic: LhMessage[] = [];
		if (input.type === "text") optimistic.push({ ...newUserMessage(input.text), id: localId() });
		else if (input.type === "thinking") {
			// The practice submissions: the marker lands optimistically — the card renders from its details the moment the button fires.
			optimistic.push({ ...newThinkingMessage(input.problemCallId, input.text), id: localId() });
		} else if (input.type === "next") {
			// The move-on signal: the NEXT PROBLEM line renders the instant the chip/Enter fires.
			optimistic.push({ ...newNextMessage(), id: localId() });
		} else if (input.type === "answer") {
			const tool = pendingCallTool([...this.base, ...this.tail], input.toolCallId) ?? "quiz";
			const result = { ...newAnswerResult(input.toolCallId, tool, input.answer), id: localId() };
			optimistic.push(result);
			this.unconfirmedAnswers.set(result.id, input.toolCallId);
		}
		if (optimistic.length > 0) this.mutate(() => {
			this.tail = [...this.tail, ...optimistic];
		});
		try {
			// SUBMITS ARE NOT ABORTABLE BY VIEW TEARDOWN: the POST must NOT ride consumeAbort.
			const res = await this.postInputEvent(input);
			if (res.status === 409) {
				throw new Error("A turn is already running — try again in a moment.");
			}
			if (!res.ok) {
				// Refusal envelopes (503 BYOK/key gates) and 400s: the RAW body text rides the error message — the banner shows it
				throw new Error((await res.text()) || `The send failed (${res.status}).`);
			}
			// CONNECTION DIET B: the POST acknowledges and closes; there is no stream on this response to consume.
			await res.text().catch(() => {}); // drain the tiny ack; release the socket
			// A stop() or a newer send/consume won while the ack was in flight: the turn is live server-side either way
			if (this.consumeAbort !== controller) return;
			await this.resumeStream(true);
		} catch (err) {
			if (this.consumeAbort !== controller || controller.signal.aborted) return;
			// Restore the question when acceptance failed or is unknown.
			if (input.type === "answer") {
				const ids = new Set(optimistic.map(m => m.id));
				this.mutate(() => {
					this.tail = this.tail.filter(m => !ids.has(m.id));
					for (const id of ids) this.unconfirmedAnswers.delete(id);
				});
			}
			this.setError((err as Error).message);
			this.setStatus("error");
		}
	}

	/** STEER: the learner's mid-turn message for the RUNNING turn. */
	async steer(text: string): Promise<void> {
		const t = text.trim();
		if (!t) return;
		const id = `steer_${localId()}`;
		this.steerQueueValue = [...this.steerQueueValue, { id, text: t }];
		this.onChange?.();
		const dropSteer = () => {
			this.steerQueueValue = this.steerQueueValue.filter((s) => s.id !== id);
			this.onChange?.();
		};
		try {
			const res = await this.fetch(`/api/chats/${this.chatId}/steer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "steer", id, text: t } }),
			});
			if (res.ok) return; // parked or delivered — the stream lands the card
			if (res.status === 409) {
				dropSteer();
				await this.send({ type: "text", text: t }); // the settle race: plain send
				return;
			}
			dropSteer();
			this.setError((await res.text()) || `The steer failed (${res.status}).`);
		} catch (err) {
			dropSteer();
			this.setError((err as Error).message);
		}
	}

	/** The answer path (the dock): the answer IS the question call's tool result (fork 1), riding as its input event. */
	submitAnswer(tool: string, toolCallId: string, output: QuestionAnswerData): Promise<void> {
		void tool;
		return this.send({ type: "answer", toolCallId, answer: output });
	}

	/** The dismissal path: the skipped toolResult lands optimistically, then the SILENT route persists it — no turn, no stream, nothing wakes. */
	async dismissQuestion(toolCallId: string, answer: QuestionAnswerData): Promise<void> {
		if (!this.readyRef) return;
		const tool = pendingCallTool([...this.base, ...this.tail], toolCallId) ?? "quiz";
		this.mutate(() => {
			this.tail = [...this.tail, { ...newAnswerResult(toolCallId, tool, answer), id: localId() }];
		});
		try {
			const res = await this.fetch(`/api/chats/${this.chatId}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "dismiss", toolCallId, answer } }),
			});
			if (!res.ok) throw new Error(`The dismissal failed (${res.status}).`);
		} catch (err) {
			this.setError((err as Error).message);
		}
	}

	/** The problem discard: the ask-style dismissal — the UI-only marker lands optimistically, then the SILENT route persists it (no turn, no wake). */
	async dismissProblem(problemCallId: string): Promise<void> {
		if (!this.readyRef) return;
		this.mutate(() => {
			this.tail = [...this.tail, { ...newProblemDismissedMarker(problemCallId), id: localId() }];
		});
		try {
			const res = await this.fetch(`/api/chats/${this.chatId}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "dismiss-problem", problemCallId } }),
			});
			if (!res.ok) throw new Error(`The dismissal failed (${res.status}).`);
		} catch (err) {
			this.setError((err as Error).message);
		}
	}

	/** Local detach: cancel the consume, keep the partial tail. */
	stop(): void {
		this.consumeAbort?.abort();
		this.consumeAbort = null;
		this.streamingIds = new Set();
		this.streamingMessageId = null;
		this.executions = new Map();
		this.setStatus("ready");
	}

	/** Submission snapshots outlive the dock, not the session mount. */
	questionDraft(toolCallId: string): QuestionDraft | undefined {
		return this.questionDrafts.get(toolCallId);
	}

	saveQuestionDraft(toolCallId: string, draft: Partial<QuestionDraft>): void {
		this.questionDrafts.set(toolCallId, { ...this.questionDrafts.get(toolCallId), ...draft });
	}

	private forgetResolvedDrafts(record: readonly LhMessage[]): void {
		const answered = answeredCallIds(record);
		for (const id of answered) this.questionDrafts.delete(id);
		for (const [id, callId] of this.unconfirmedAnswers) {
			if (answered.has(callId)) this.unconfirmedAnswers.delete(id);
		}
	}

	/** Full snapshot swap (the idle settle sync — server canon). */
	setMessages(record: LhMessage[], turnError?: string): void {
		this.mutate(() => {
			this.base = record;
			if (turnError !== undefined) {
				this.errorValue = { message: turnError };
				this.automaticContinuationBlocked = true;
			}
			this.forgetResolvedDrafts(record);
			this.incompleteUsageIds.clear();
			this.tail = [];
			this.streamingMessageId = null; // the tail (and its slot) is gone
		});
	}

	/** Append-only adoption (the mid-turn steer/artifact ground rule): swap in the record */
	adoptRecord(record: LhMessage[]): void {
		const recordIds = new Set(record.map((m) => (m as { id?: string }).id));
		const baseAbsorbed = this.base.some((m) => !recordIds.has((m as { id?: string }).id));
		if (baseAbsorbed) return; // not a pure append — the idle full sync is the net
		this.mutate(() => {
			this.base = record;
			this.forgetResolvedDrafts(record);
			this.tail = this.tail.filter((m) => !absorbed(m, record));
		});
	}

	/** Automatic mount/sync continuation is never permission to retry a failed turn. */
	async continueIfOwed(record: readonly LhMessage[]): Promise<void> {
		if (this.statusValue === "ready" && !this.automaticContinuationBlocked && this.getState().error === null && needsContinuation(record)) {
			await this.send({ type: "continue" });
		}
	}

	/** The mount/sync continuation fold (native-messages.ts). */
	static needsContinuation = needsContinuation;

	clearError(): void {
		this.setError(null);
	}
}
