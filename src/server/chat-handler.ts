import type { AgentMessage } from "../core/agent-types.ts";
import { runPiTurn } from "./pi/ui-stream.ts";
import { stores } from "./stores.ts";
import { beginTurn, endTurn, isTurnRunning } from "./turn-liveness.ts";
import { applyParkedDismissal } from "./dismissal-park.ts";
import { registerTurn, rememberTurnFailure, settledTurnResponse, unregisterTurn } from "./turn-runs.ts";
import { persistTurn, TurnPersistenceError } from "./turn-service.ts";
import { asAgentMessages, danglingQuestionOf, type LhMessage } from "../core/native-messages.ts";
import { emit } from "../core/events.ts";
import { ChatInputError, inputAppends, parseChatInput, type ChatInput } from "../core/input-events.ts";
import { BridgeAgent, claudeSession, deliver } from "./claude/session.ts";

/** One chat turn over the server-owned native record, bridged to the learner's Claude Code (docs/claude-code-bridge.md). */

function settlementErrorText(error: unknown): string {
	return error instanceof TurnPersistenceError ? error.message : "An error occurred.";
}

/** The route-facing entry: parse {chatId, input} and handle one input. */
export async function handleChatRequest(req: Request): Promise<Response> {
	let body: { chatId?: unknown; input?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId) return Response.json({ error: "Unknown chat" }, { status: 404 });
	let input: ChatInput;
	try {
		input = parseChatInput(body.input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
	return handleChatInput(chatId, input);
}

/** The model-facing text of the learner's appended messages — what Claude receives as the parked call's result. */
function learnerText(appends: readonly LhMessage[]): string {
	const parts: string[] = [];
	for (const m of appends) {
		const message = m as { role?: string; content?: unknown; toolName?: string };
		const text = textOf(message.content);
		if (message.role === "user") parts.push(text);
		else if (message.role === "toolResult") parts.push(`Learner's response to ${message.toolName}: ${text}`);
		else if (message.role === "custom" && text) parts.push(text);
	}
	return parts.filter(Boolean).join("\n\n");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? (part as { text: string }).text : ""))
		.filter(Boolean)
		.join("\n");
}

/** One input event → native record appends → delivered to Claude. */
export async function handleChatInput(chatId: string, input: ChatInput): Promise<Response> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}

	let appends: LhMessage[];
	try {
		appends = input.type === "continue" ? [] : inputAppends(record, input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}

	// One turn per chat, ever: while Claude is producing a reply the composer steers (POST /api/chats/[id]/steer) instead of sending.
	if (isTurnRunning(chatId)) {
		return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
	}

	// Write-ahead: the learner's input is durable the instant it arrives.
	const merged = [...record.messages, ...appends];
	try {
		if (appends.length > 0) stores.chatStore.saveMessages(chatId, merged);
	} catch (err) {
		console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
		return new Response("Your input could not be saved. Please try again.", { status: 500 });
	}
	emit("record-changed", { chatId });

	// An answer that leaves a sibling question dangling waits for the last one.
	if (input.type === "answer" && danglingQuestionOf(merged) !== null) return settledTurnResponse();

	const text = learnerText(appends);
	const session = claudeSession(chatId);
	if (input.type === "continue" && !session.blocked) return settledTurnResponse();
	if (!deliver(session, text || "(The learner asked you to continue.)")) {
		// Nothing parked: Claude is busy or not running — the inbox holds it.
		return Response.json({ ok: true, queued: true });
	}
	startBridgeTurn(chatId);
	return Response.json({ ok: true });
}

/** Open a turn for Claude's output: a BridgeAgent over the current record, run as a background object every view can attach to. */
export function startBridgeTurn(chatId: string): BridgeAgent | undefined {
	const session = claudeSession(chatId);
	if (session.agent && !session.agent.settled) return session.agent;
	const record = stores.chatStore.getChat(chatId);
	if (!record) return undefined;
	if (!beginTurn(chatId)) return session.agent;

	const base: AgentMessage[] = asAgentMessages(record.messages);
	const agent = new BridgeAgent(base);
	session.agent = agent;
	const handle = runPiTurn({
		agent: agent as never,
		...(process.env.LH_UPDATE_FLUSH_MS ? { updateFlushMs: Number(process.env.LH_UPDATE_FLUSH_MS) } : {}),
		onError: (error) => {
			console.error(`[chat ${chatId}] turn error:`, error);
			return "An error occurred.";
		},
		onSettleError: settlementErrorText,
		onSettleFailure: (error, reportedErrorText) => {
			rememberTurnFailure(chatId, reportedErrorText ?? settlementErrorText(error));
			endTurn(chatId);
			unregisterTurn(chatId);
		},
		onFinish: (turnMessages, isAborted) => {
			if (session.agent === agent) session.agent = undefined;
			if (isAborted || agent.aborted) session.stopRequested = true;
			persistTurn(stores.chatStore, chatId, base.length, turnMessages, isAborted || agent.aborted);
			applyParkedDismissal(stores.chatStore, chatId);
			endTurn(chatId);
			unregisterTurn(chatId);
		},
	});
	registerTurn(chatId, handle);
	emit("record-changed", { chatId });
	return agent;
}

/** Mid-reply composer input (POST /api/chats/[id]/steer) */
export function steerClaude(chatId: string, message: LhMessage): boolean {
	const session = claudeSession(chatId);
	const agent = session.agent;
	if (!agent || agent.settled) return false;
	agent.push(message as never);
	session.inbox.push(learnerText([message]));
	return true;
}

/** A dismissed question releases Claude's parked call (no turn opens: the learner skipped it; Claude decides what comes next). */
export function deliverDismissal(chatId: string, appends: readonly LhMessage[]): void {
	const session = claudeSession(chatId);
	if (session.blocked?.kind !== "question") return;
	deliver(session, `${learnerText(appends)}\n\nThe learner dismissed this question without answering. Do not re-ask it; continue (usually: wait_for_learner).`);
}
