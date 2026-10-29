import type { AgentEvent } from "../../core/agent-types.ts";

/** TOOL-CALL ID UNIQUIFICATION: some providers (DeepSeek via OpenRouter, observed live) return tool-call ids that reset every response — `call_0` */

/** Structurally walk any message's content for tool-call blocks. */
function callBlocks(message: unknown): Array<{ id: string } & Record<string, unknown>> {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(b): b is { id: string } & Record<string, unknown> =>
			(b as { type?: string } | null)?.type === "toolCall" && typeof (b as { id?: unknown }).id === "string",
	);
}


export class ToolCallIdUniquifier {
	private readonly seen = new Set<string>();
	/** assistant message object → its (origId → uniqueId) table. */
	private readonly tables = new WeakMap<object, Map<string, string>>();
	/** The current assistant message's table — opened at its message_start, shared by its update/end objects */
	private epoch: Map<string, string> | null = null;

	constructor(usedIds: Iterable<string>) {
		for (const id of usedIds) this.seen.add(id);
	}

	/** Keep `orig` if never used; otherwise mint an unused `${orig}~n`. */
	private claim(orig: string): string {
		if (!this.seen.has(orig)) {
			this.seen.add(orig);
			return orig;
		}
		for (let n = 2; ; n++) {
			const candidate = `${orig}~${n}`;
			if (!this.seen.has(candidate)) {
				this.seen.add(candidate);
				return candidate;
			}
		}
	}

	/** Register + rewrite one message's tool-call blocks (idempotent across the repeated partials of message_update). */
	private remapMessageContent(message: unknown): unknown {
		if ((message as { role?: string }).role !== "assistant") return message;
		const blocks = callBlocks(message);
		if (blocks.length === 0) return message;

		// Attach to the current epoch unless this object already has a table (a re-emitted update/end).
		let table = this.tables.get(message as object);
		if (!table) {
			table = this.epoch ?? new Map();
			this.epoch = table;
			this.tables.set(message as object, table);
		} else {
			this.epoch = table;
		}

		let changed = false;
		const content = (message as { content: unknown[] }).content.map((block) => {
			if ((block as { type?: string }).type !== "toolCall") return block;
			const orig = (block as { id?: unknown }).id;
			if (typeof orig !== "string") return block;
			let mapped = table!.get(orig);
			if (mapped === undefined) {
				mapped = this.claim(orig);
				table!.set(orig, mapped);
			}
			if (mapped === orig) return block;
			changed = true;
			return { ...(block as object), id: mapped };
		});
		return changed ? { ...(message as object), content } : message;
	}

	/** Every AgentEvent, ids uniquified. */
	event(event: AgentEvent): AgentEvent {
		switch (event.type) {
			case "message_start": {
				const e = event as { message: { role?: string } };
				// A new assistant message opens a fresh epoch — this is what keeps a retried id in a LATER message from reusing the earlier message's mint.
				if (e.message?.role === "assistant") this.epoch = new Map();
				return this.remapEventMessage(event);
			}
			case "message_update":
			case "message_end":
				return this.remapEventMessage(event);
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end": {
				const { toolCallId } = event as { toolCallId: string };
				const mapped = this.epoch?.get(toolCallId) ?? toolCallId;
				if (mapped === toolCallId) return event;
				return { ...(event as object), toolCallId: mapped } as AgentEvent;
			}
			case "turn_end": {
				const e = event as { message: unknown; toolResults: Array<{ toolCallId?: string }> };
				const message = this.remapMessageContent(e.message);
				const table = this.epoch;
				const toolResults = table
					? e.toolResults.map((r) =>
							typeof r.toolCallId === "string" && table.has(r.toolCallId)
								? { ...r, toolCallId: table.get(r.toolCallId)! }
								: r,
						)
					: e.toolResults;
				return { ...(e as object), message, toolResults } as unknown as AgentEvent;
			}
			case "agent_end": {
				const e = event as { messages: unknown[] };
				return { ...(e as object), messages: this.remapSettled(e.messages) } as unknown as AgentEvent;
			}
			default:
				return event;
		}
	}

	private remapEventMessage(event: AgentEvent): AgentEvent {
		const e = event as { message: unknown };
		const remapped = this.remapMessageContent(e.message);
		if (remapped === e.message) return event;
		return { ...(event as object), message: remapped } as AgentEvent;
	}

	/** The settle seam: the agent's final state, rewritten to the ids the wire already showed. */
	remapSettled(messages: readonly unknown[]): unknown[] {
		let scope: Map<string, string> | undefined;
		return messages.map((m) => {
			const role = (m as { role?: string }).role;
			if (role === "assistant") {
				const table = this.tables.get(m as object);
				if (!table) {
					// Prior-turn or unregistered: history is never rewritten.
					scope = undefined;
					return m;
				}
				scope = table;
				return this.remapMessageContent(m);
			}
			if (role === "toolResult") {
				const orig = (m as { toolCallId?: unknown }).toolCallId;
				if (scope && typeof orig === "string" && scope.has(orig)) {
					return { ...(m as object), toolCallId: scope.get(orig)! };
				}
				return m;
			}
			return m;
		});
	}
}
