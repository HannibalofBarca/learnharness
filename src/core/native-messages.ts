/** THE NATIVE MESSAGE RECORD: chat records store pi's own message shapes — the exact history the agent loop builds — instead of AI-SDK UIMessages. */

import type { AgentMessage } from "./agent-types.ts";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "./agent-types.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import {
	CONCLUDE_ACK_TEXT,
	HANDOFF_TEXT,
	NEXT_PROBLEM_TEXT,
	THINKING_LABEL,
} from "./contracts/chat.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "./question-core.ts";


// ─── The record's message type ───────────────────────────────────────────────

/** The app's custom message (declaration-merged into pi-agent-core's CustomAgentMessages below). */
export interface LhMarkerMessage {
	/** Record identity (pi messages carry no id — see the file header). */
	id: string;
	role: "custom";
	customType:
		| "graph-context"
		| "probe-handoff"
		| "subagent-steer"
		| "subagent-abort"
		| "plan-block"
		| "practice-thinking"
		| "practice-next"
		| "problem-dismissed"
		| "compaction";
	/** The model-facing text ("" for plan blocks — UI-only). */
	content: string;
	display: boolean;
	/** The UI payload — per-customType, never model-visible. */
	details: unknown;
	timestamp: number;
}


/** A record message: a native pi message (or our marker) plus the record id. */
export type LhMessage = (UserMessage | AssistantMessage | ToolResultMessage | LhMarkerMessage) & { id: string };

/** A record message list is assignable to the agent's context — that IS the replay (ui-stream/chat-handler assign it to initialState.messages). */
export function asAgentMessages(messages: readonly LhMessage[]): AgentMessage[] {
	return messages as unknown as AgentMessage[];
}

// ─── explicit learner-facing output ─────────────────────────────────────────

export const SEND_TO_USER_TOOL = "send_to_user";

/** Read the output tool's message without changing the native call. */
export function sendToUserText(block: unknown): string | undefined {
	if (!block || typeof block !== "object") return undefined;
	const call = block as { type?: unknown; name?: unknown; arguments?: unknown };
	if (call.type !== "toolCall" || call.name !== SEND_TO_USER_TOOL) return undefined;
	if (!call.arguments || typeof call.arguments !== "object") return undefined;
	const message = (call.arguments as { message?: unknown }).message;
	return typeof message === "string" && message.trim() ? message : undefined;
}

/** Learner-facing prose, in content order. */
export function userFacingTextOf(content: unknown, failedOutputCalls?: ReadonlySet<string>): string[] {
	if (typeof content === "string") return content.trim() ? [content] : [];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "toolCall" && failedOutputCalls?.has(block.id)) continue;
		const text = block.type === "text" ? block.text : sendToUserText(block);
		if (typeof text === "string" && text.trim()) out.push(text);
	}
	return out;
}

/** Failed output calls remain retry context, not delivered teaching. */
export function failedOutputCallIds(messages: readonly LhMessage[]): ReadonlySet<string> {
	const failed = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolName === SEND_TO_USER_TOOL && message.isError) {
			failed.add(message.toolCallId);
		} else if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === SEND_TO_USER_TOOL) failed.add(block.id);
			}
		}
	}
	return failed;
}

// ─── id minting ──────────────────────────────────────────────────────────────

/** The app-wide message id shape (same as the UIMessage-era mint). */
export function newMessageId(): string {
	return `msg_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

// ─── constructors (the input-event → native append mapping lives in core/input-events.ts; steers in core/contracts/jobs.ts) ─────────────────

/** A learner-authored user message (text input, verdict note). */
export function newUserMessage(text: string): LhMessage & UserMessage {
	return {
		id: newMessageId(),
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

/** A steered user message: a plain user message with the CLIENT-minted steer id — the same object rides agent.steer(), the live stream's message events */
export function newUserSteer(text: string, id: string): LhMessage & UserMessage {
	return { id, role: "user", content: text, timestamp: Date.now() };
}

/** The learner's answer — the question call's tool result (fork 1). */
export function newAnswerResult(
	toolCallId: string,
	toolName: string,
	answer: unknown,
): LhMessage & ToolResultMessage {
	return {
		id: newMessageId(),
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(compactAnswerForModel(answer as QuestionAnswerData)) }],
		// 0.87.1 narrowed ToolResultMessage.details to JsonRepresentation — our payloads are JSON-safe answer structures, so the cast is honest.
		details: answer as ToolResultMessage["details"],
		isError: false,
		timestamp: Date.now(),
	};
}

/** The probe→teach handoff wake: scaffolding, not speech — the model reads HANDOFF_TEXT, the UI renders the quiet system line. */
export function newHandoffMessage(chatId: string): LhMarkerMessage {
	return {
		id: `steer_probe_${chatId}`,
		role: "custom",
		customType: "probe-handoff",
		content: HANDOFF_TEXT,
		display: true,
		details: { chatId },
		timestamp: Date.now(),
	};
}

/** The plan presentation block: pure UI history (a frozen snapshot), no model face — toLlmMessages filters it. */
export function newPlanBlockMessage(
	planCallId: string,
	block: unknown,
): LhMarkerMessage {
	return {
		id: `pb_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		role: "custom",
		customType: "plan-block",
		content: "",
		display: true,
		details: { planCallId, block },
		timestamp: Date.now(),
	};
}

// ─── practice sessions ───────────────────────────────────

/** The practice agent's two tools (the conclude-before-next-problem gate's vocabulary — the tool-execute layer owns the tools themselves). */
export const PRACTICE_PROBLEM_TOOL = "problem";
export const PRACTICE_CONCLUDE_TOOL = "conclude";

/** One picked proposition of the graph-context marker (the learner's map pick — name + statement as the learner SAW them at pick time). */
export interface GraphContextPick {
	id: string;
	name: string;
	statement: string;
}

/** The session's map context: a SEPARATE custom message BEFORE the learner's first user message */
export function newGraphContextMessage(picks: readonly GraphContextPick[], chains: readonly string[]): LhMarkerMessage {
	// IDS FIRST: each proposition is introduced ONCE with its id, name, and statement
	const lines = [
		// PREAMBLE LAW: custom markers flatten to USER-role messages on the wire (toLlmMessages) — this text arrives in the learner's voice channel
		"[Session context] — picked from the learner's knowledge map when starting this session:",
		"",
		"Propositions (id — name: statement; the problem tool's target field uses these ids):",
		...picks.map((p) => `- [${p.id}] ${p.name}: ${p.statement}`),
	];
	if (chains.length > 0) {
		lines.push("", "Reasoning chains among them (premises → conclusion):", ...chains.map((c) => `- ${c}`));
	}
	return {
		id: newMessageId(),
		role: "custom",
		customType: "graph-context",
		content: lines.join("\n"),
		display: true,
		details: { propositions: picks, chains },
		timestamp: Date.now(),
	};
}

/** The learner's thinking submission: the register is no longer declared by a button */
export function newThinkingMessage(problemCallId: string, text: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "practice-thinking",
		content: `${THINKING_LABEL}:\n${text}`,
		display: true,
		details: { problemCallId, text },
		timestamp: Date.now(),
	};
}

/** The learner's explicit move-on signal: appended by the next input (the composer band's chip */
export function newNextMessage(): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "practice-next",
		content: NEXT_PROBLEM_TEXT,
		display: true,
		details: {},
		timestamp: Date.now(),
	};
}

/** The problem-dismissal marker: UI-ONLY — toLlmMessages filters it. */
export function newProblemDismissedMarker(problemCallId: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "problem-dismissed",
		content: "",
		display: true,
		details: { problemCallId },
		timestamp: Date.now(),
	};
}

/** The dismissal's deferred conclude: the pair prepended to the user's NEXT input */
export function concludedByDismissalPair(
	problemCallId: string,
): [LhMessage & AssistantMessage, LhMessage & ToolResultMessage] {
	const callId = `call_conc_${problemCallId}`;
	const now = Date.now();
	// The stamps are placeholders by design: history serialization reads ONLY the content blocks (verified in pi-ai's converters)
	const syntheticStamps = {
		api: "faux",
		provider: "synthetic",
		model: "synthetic-conclude",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	} as const;
	return [
		{
			id: newMessageId(),
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: PRACTICE_CONCLUDE_TOOL, arguments: { outcome: "dismissed" } }],
			timestamp: now,
			...syntheticStamps,
		},
		{
			id: newMessageId(),
			role: "toolResult",
			toolCallId: callId,
			toolName: PRACTICE_CONCLUDE_TOOL,
			content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
			details: { outcome: "dismissed", problemCallId },
			isError: false,
			timestamp: now,
		},
	];
}

/** The active-problem fold (the conclude-before-next-problem gate): the NEWEST problem tool call with nothing concluding after it */
/** The ids of tool calls whose results are CLEAN (not errored) — the only calls that ever happened, per the honest-activation ruling. */
function cleanToolCallIds(messages: readonly LhMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (!result.isError) ids.add(result.toolCallId);
	}
	return ids;
}

/** The conclusion's reveal: the hero of a conclude card is the modelSolution committed at POSE time */
export function modelSolutionForConclude(
	messages: readonly LhMessage[],
	concludeCallId: string,
): string | undefined {
	const input = problemInputForConclude(messages, concludeCallId);
	return typeof input?.modelSolution === "string" ? input.modelSolution : undefined;
}

/** The full pose-side fold: EVERYTHING the agent filled into the problem call — mode, target ids, statement, the committed solution */
export function problemInputForConclude(
	messages: readonly LhMessage[],
	concludeCallId: string,
): { statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown } | undefined {
	let mi = messages.findIndex(
		(m) =>
			(m as { role?: string }).role === "assistant" &&
			(m as AssistantMessage).content.some(
				(b) => b.type === "toolCall" && b.id === concludeCallId,
			),
	);
	if (mi < 0) return undefined;
	const clean = cleanToolCallIds(messages);
	for (; mi >= 0; mi--) {
		const m = messages[mi]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
			const block = assistant.content[bi]!;
			if (block.type !== "toolCall" || block.name !== PRACTICE_PROBLEM_TOOL) continue;
			if (!clean.has(block.id)) continue; // a refused pose revealed nothing
			return (block.arguments ?? undefined) as
				| { statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown }
				| undefined;
		}
	}
	return undefined;
}

export function activeProblemOf(
	messages: readonly LhMessage[],
): { toolCallId: string; input: unknown } | null {
	// HONEST ACTIVATION: calls count only through their RESULTS — a problem activates on its clean ack, a conclude frees on its clean ack
	const cleanCallIds = cleanToolCallIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "problem-dismissed") return null;
			continue;
		}
		if (role === "assistant") {
			const assistant = m as AssistantMessage & { id: string };
			for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
				const block = assistant.content[bi]!;
				if (block.type !== "toolCall") continue;
				if (block.name === PRACTICE_CONCLUDE_TOOL) {
					if (cleanCallIds.has(block.id)) return null; // a CLEAN conclude frees
					continue; // errored/dangling conclude: the free never happened
				}
				if (block.name !== PRACTICE_PROBLEM_TOOL) continue;
				if (cleanCallIds.has(block.id)) return { toolCallId: block.id, input: block.arguments };
				// errored/dangling pose — it did not go through; keep scanning
			}
			continue;
		}
	}
	return null;
}

/** Is a problem-dismissal marker waiting for its conclude synthesis? */
export function pendingProblemDismissalOf(messages: readonly LhMessage[]): string | null {
	const cleanCallIds = cleanToolCallIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "problem-dismissed") {
				return (marker.details as { problemCallId?: unknown }).problemCallId as string;
			}
			continue;
		}
		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
				const block = assistant.content[bi]!;
				if (block.type !== "toolCall" && block.type !== "text") continue;
				if (block.type === "toolCall" && block.name === PRACTICE_CONCLUDE_TOOL) {
					if (cleanCallIds.has(block.id)) return null; // a CLEAN conclude settles it
					continue; // errored/dangling: it never happened
				}
				if (block.type === "toolCall" && block.name === PRACTICE_PROBLEM_TOOL) {
					if (cleanCallIds.has(block.id)) return null; // a CLEAN pose supersedes it
					continue;
				}
			}
			continue;
		}
	}
	return null;
}

// ─── the one model-facing seam (the agent's convertToLlm) ────────────────────

/** The ids of every toolResult in the tail (for the dangling-call scan). */
function resultIdsFrom(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult") {
			ids.add((m as ToolResultMessage).toolCallId);
		}
	}
	return ids;
}


// ─── native scans (the UIMessage-era pending/phase seams, natively) ──────────

/** The pending-question gate (findPendingToolCall's native twin): the NEWEST assistant message's FIRST question-tool call with no result in the tail */
export function danglingQuestionOf(
	messages: readonly LhMessage[],
): { toolCallId: string; tool: string; input: unknown } | null {
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage & { id: string };
		const answered = resultIdsFrom(messages.slice(mi + 1));
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			if (!(QUESTION_TOOLS as readonly string[]).includes(block.name)) continue;
			if (answered.has(block.id)) continue;
			return { toolCallId: block.id, tool: block.name, input: block.arguments };
		}
		return null; // the newest assistant message's questions are all answered
	}
	return null;
}

/** The probe→teach construction seam (chat-handler): a probe_done call in the transcript — any state — means the probe is concluded: teach. */
export function hasProbeDone(messages: readonly LhMessage[]): boolean {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		if (assistant.content.some((b) => b.type === "toolCall" && b.name === "probe_done")) return true;
	}
	return false;
}

/** Every toolResult id in the record — answer-event validation (the call must be a DANGLING question call, not an already-answered one). */
export function answeredCallIds(messages: readonly LhMessage[]): Set<string> {
	return resultIdsFrom(messages);
}

// ─── the continuation fold ──────────────────

/** Does the record END on un-consumed tool results — a turn that stopped after its tools ran (a job dispatch's ack, an aborted answer turn) */
/** Is this record message a user-dismissed question result? */
function isDismissedResult(m: LhMessage): boolean {
	if ((m as { role?: string }).role !== "toolResult") return false;
	const details = (m as { details?: unknown }).details as { dismissed?: unknown } | undefined;
	return details?.dismissed === true;
}



export function needsContinuation(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	if (!last || (last as { role?: string }).role !== "toolResult") return false;
	// The trailing results batch (contiguous by construction — the agent appends its batch
	let start = messages.length - 1;
	while (
		start > 0 &&
		(messages[start - 1] as { role?: string } | undefined)?.role === "toolResult"
	) {
		start--;
	}
	// The dismissal rule: the batch's LAST resolution decides.
	if (isDismissedResult(messages[messages.length - 1]!)) {
		return false;
	}
	const owner = messages[start - 1];
	if (!owner || (owner as { role?: string }).role !== "assistant") return false;
	const content = (owner as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	const results = messages.slice(start) as ToolResultMessage[];
	// PRACTICE: a batch acking a problem POSE owes nothing
	const posedProblem = results.some(
		(m) => m.toolName === PRACTICE_PROBLEM_TOOL && !m.isError && m.details == null,
	);
	if (posedProblem) return false;
	const answered = new Set(results.map((m) => m.toolCallId));
	const calls = (content as Array<{ type?: string; id?: string }>).filter(
		(b) => b.type === "toolCall" && typeof b.id === "string",
	);
	return calls.length > 0 && calls.every((b) => answered.has(b.id!));
}
