/**
 * The Claude Code bridge session (docs/claude-code-bridge.md): one per chat,
 * on globalThis (Next dev compiles each route as its own module instance —
 * the MCP route and POST /api/chat must share it; same discipline as
 * turn-runs.ts).
 *
 * It joins two lifecycles:
 * - Claude's side: MCP tool calls. Output tools stream into the CURRENT
 *   BridgeAgent (opening a turn when none runs); a blocking call (question
 *   tool, problem, wait_for_learner) parks in `blocked` and settles the turn.
 * - The learner's side: POST /api/chat inputs. Their model-facing text
 *   resolves the parked call, or waits in `inbox` for Claude's next
 *   wait_for_learner when Claude is busy or not running.
 *
 * BridgeAgent is the subset of a pi Agent that runPiTurn drives:
 * `state.messages`, `subscribe`, `continue()`, `abort()`. `continue()`
 * resolves when Claude blocks again (or the learner stops the turn).
 */

import type { AgentEvent, AgentMessage } from "../../core/agent-types.ts";

type Listener = (event: AgentEvent) => void;

export class BridgeAgent {
	state: { messages: AgentMessage[] };
	private listeners = new Set<Listener>();
	private finish: (() => void) | undefined;
	private finished = false;
	aborted = false;

	constructor(messages: AgentMessage[]) {
		this.state = { messages: [...messages] };
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	/** Append a settled message and stream it (start + end — no partials:
	 *  a tool call arrives whole). */
	push(message: AgentMessage): void {
		this.state.messages.push(message);
		this.emit({ type: "message_start", message } as AgentEvent);
		this.emit({ type: "message_end", message } as AgentEvent);
	}

	async continue(): Promise<void> {
		this.emit({ type: "agent_start" } as AgentEvent);
		if (!this.finished) await new Promise<void>((resolve) => (this.finish = resolve));
		this.emit({ type: "agent_end", messages: [...this.state.messages] } as AgentEvent);
	}

	/** Claude blocked (or stopped): the turn settles. Idempotent. */
	settle(): void {
		if (this.finished) return;
		this.finished = true;
		this.finish?.();
	}

	get settled(): boolean {
		return this.finished;
	}

	abort(): void {
		this.aborted = true;
		this.settle();
	}
}

/** What a parked MCP call is waiting for. */
export type BlockedKind = "question" | "problem" | "wait";

interface Blocked {
	kind: BlockedKind;
	/** The question/problem call id (absent for wait_for_learner). */
	toolCallId?: string;
	resolve: (text: string) => void;
}

export interface ClaudeSession {
	chatId: string;
	agent: BridgeAgent | undefined;
	blocked: Blocked | undefined;
	/** Learner input that arrived while no call was parked. */
	inbox: string[];
	/** The learner pressed stop: the next output call is refused once. */
	stopRequested: boolean;
	/** Serializes Claude's calls: one tool at a time per chat. */
	queue: Promise<unknown>;
}

interface BridgeGlobal {
	__lhClaudeSessions?: Map<string, ClaudeSession>;
}

function sessions(): Map<string, ClaudeSession> {
	const g = globalThis as typeof globalThis & BridgeGlobal;
	return (g.__lhClaudeSessions ??= new Map());
}

export function claudeSession(chatId: string): ClaudeSession {
	let session = sessions().get(chatId);
	if (!session) {
		session = { chatId, agent: undefined, blocked: undefined, inbox: [], stopRequested: false, queue: Promise.resolve() };
		sessions().set(chatId, session);
	}
	return session;
}

export function dropClaudeSession(chatId: string): void {
	const session = sessions().get(chatId);
	session?.agent?.settle();
	sessions().delete(chatId);
}

/** Run one Claude tool call after the previous one for this chat finished
 *  (parallel tool calls from Claude must not interleave turns). */
export function serialized<T>(session: ClaudeSession, run: () => Promise<T>): Promise<T> {
	const next = session.queue.then(run, run);
	session.queue = next.catch(() => undefined);
	return next;
}

/** Park a blocking call: settles the running turn so the GUI shows the
 *  question / composer, then waits for the learner. Inbox text that is
 *  already waiting answers a wait_for_learner immediately. */
export function block(session: ClaudeSession, kind: BlockedKind, signal: AbortSignal, toolCallId?: string): Promise<string> {
	if (kind === "wait" && session.inbox.length > 0) {
		const text = session.inbox.splice(0).join("\n\n");
		return Promise.resolve(text);
	}
	session.agent?.settle();
	session.agent = undefined;
	return new Promise<string>((resolve, reject) => {
		const blocked: Blocked = {
			kind,
			toolCallId,
			resolve: (text) => {
				signal.removeEventListener("abort", onAbort);
				resolve(text);
			},
		};
		const onAbort = () => {
			if (session.blocked === blocked) session.blocked = undefined;
			reject(new Error("Claude disconnected"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		session.blocked = blocked;
	});
}

/** Deliver learner input. Returns true when a parked call took it (a turn
 *  should open: Claude is working again), false when it was queued. */
export function deliver(session: ClaudeSession, text: string): boolean {
	const blocked = session.blocked;
	if (!blocked) {
		session.inbox.push(text);
		return false;
	}
	session.blocked = undefined;
	blocked.resolve(text);
	return true;
}
