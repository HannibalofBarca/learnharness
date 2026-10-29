/** The chat-turn services — one named seam per turn responsibility, extracted from the chat-handler so it composes instead of implementing. */

import type { AgentMessage } from "../core/agent-types.ts";
import type { ToolResultMessage } from "../core/agent-types.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { newMessageId } from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { planBlocksFor } from "../core/plan-blocks.ts";
import type { ChatStore } from "../core/ports.ts";

/** Distinguish a failed canonical save from later bookkeeping failures. */
export class TurnPersistenceError extends Error {
	constructor(cause: unknown) {
		super("The reply could not be saved.", { cause });
		this.name = "TurnPersistenceError";
	}
}

/** The canonical state write: append the turn's own messages — the agent loop's native history */
export function persistTurn(
	chatStore: ChatStore,
	chatId: string,
	baseCount: number,
	turnMessages: readonly AgentMessage[],
	isAborted: boolean,
): LhMessage[] {
	try {
		const record = chatStore.getChat(chatId);
		if (!record) throw new Error(`Chat not found: ${chatId}`);
		const stamped: LhMessage[] = [];
		for (const m of turnMessages.slice(baseCount)) {
			const message = m as LhMessage;
			// The placeholder question result: loop device, never a record fact.
			if (
				(message as { role?: string }).role === "toolResult" &&
				(QUESTION_TOOLS as readonly string[]).includes((message as ToolResultMessage).toolName) &&
				!(message as ToolResultMessage).isError
			) {
				continue;
			}
			stamped.push(message.id ? message : ({ ...message, id: newMessageId() } as LhMessage));
		}
		const tree = record.tree;
		const blocks = planBlocksFor(record.messages, stamped, tree, [
			...record.messages,
			...stamped,
		]);
		chatStore.saveMessages(chatId, [...record.messages, ...stamped, ...blocks]);
		return stamped;
	} catch (err) {
		console.error(`[chat ${chatId}] persist failed:`, err, { isAborted });
		throw new TurnPersistenceError(err);
	}
}
