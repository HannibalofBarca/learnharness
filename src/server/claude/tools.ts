/**
 * The LearnHarness tools as Claude Code sees them (docs/claude-code-bridge.md).
 *
 * The tool DEFINITIONS are the app's own (src/agent/tools*): the prober,
 * teacher and practice registries, their TypeBox schemas, authoring
 * refinements and argument heals. This module adds what the old engine's
 * loop used to do around them — argument validation, the native message
 * shape (assistant toolCall + toolResult), and the question-stop rule —
 * and the bridge-only tools (wait_for_learner, resume_session, set_title).
 *
 * Claude Code lists tools once per launch, so the list is the union of a
 * session kind's phases; the phase is checked per call (a teacher tool
 * before probe_done is refused with a retryable error).
 */

import { randomUUID } from "node:crypto";
import { Type, type TSchema } from "typebox";
import type { AgentTool, AgentToolResult } from "../../core/agent-types.ts";
import { askUserQuestionTool, createProberTools, createTeacherTools } from "../../agent/tools.ts";
import { practiceTools } from "../../agent/tools/practice.ts";
import { sendToUserTool } from "../../agent/tools/send-to-user.ts";
import { withArgumentHeal } from "../../agent/tools/heal.ts";
import { QUESTION_TOOLS } from "../../core/pending.ts";
import { hasProbeDone, newMessageId, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../../core/native-messages.ts";
import { sessionMarkdown } from "../../core/session-markdown.ts";
import { graphToolsEnabled } from "../../core/settings-resolution.ts";
import type { ChatRecord } from "../../core/contracts.ts";
import { effectiveSettings, stores } from "../stores.ts";
import { startBridgeTurn } from "../chat-handler.ts";
import { block, claudeSession, serialized, type ClaudeSession } from "./session.ts";
import { callGraphTool, GRAPH_TOOLS } from "./graph-tools.ts";
import { callDeliverTool, DELIVER_TOOLS } from "./deliver-tools.ts";
import { callCodingTool, CODING_TOOLS } from "./coding.ts";
import { callTreeTutorTool, outline, readTree, TREE_TUTOR_TOOLS } from "./learning-tree.ts";

export type Phase = "prober" | "teacher" | "practice" | "code";

/** Names Claude Code covers itself or the deliver tools replace — never
 *  listed even if a registry still carried them. */
const REPLACED = new Set(["read", "ls", "find", "grep", "research", "demo", "visual", "pdf"]);

/** The wire result an MCP call returns. */
export interface BridgeResult {
	text: string;
	images?: { data: string; mimeType: string }[];
	isError?: boolean;
}

/** One listed tool. */
export interface ListedTool {
	name: string;
	description: string;
	inputSchema: TSchema;
}

function strip(tools: Record<string, AgentTool<any>>): Record<string, AgentTool<any>> {
	return Object.fromEntries(Object.entries(tools).filter(([name]) => !REPLACED.has(name)));
}

/** The registry for one phase of one chat — the same builders the engine used. */
export function phaseTools(chatId: string, phase: Phase): Record<string, AgentTool<any>> {
	const effective = effectiveSettings();
	const graph = graphToolsEnabled(effective) ? { chatStore: stores.chatStore, graphStore: stores.graphStore } : undefined;
	const sendToUser = { [sendToUserTool.name]: withArgumentHeal(sendToUserTool) };
	if (phase === "practice") {
		return {
			...sendToUser,
			...strip(practiceTools({ chatId, chatStore: stores.chatStore, graphNodes: () => stores.graphStore.readNodes(), ...(graph ? { graph } : {}) })),
		};
	}
	// Coding chats (owner 2026-10-29): a conversational helper — no probe,
	// no plan, no quizzes; it asks the learner a question when it must.
	if (phase === "code") return { ...sendToUser, [askUserQuestionTool.name]: withArgumentHeal(askUserQuestionTool) };
	const base = { chatId, chatStore: stores.chatStore };
	if (phase === "prober") {
		return { ...sendToUser, ...strip(createProberTools({ ...base, deliver: () => undefined, ...(graph ? { graphStore: stores.graphStore } : {}) }, effective.agent.tools)) };
	}
	return { ...sendToUser, ...strip(createTeacherTools(base, effective.agent.tools)) };
}

export function phaseOf(record: ChatRecord): Phase {
	if (record.kind === "practice") return "practice";
	if (record.kind === "code") return "code";
	return hasProbeDone(record.messages) ? "teacher" : "prober";
}

// ─── bridge-only tools ──────────────────────────────────────────────────────

const BRIDGE_TOOLS: ListedTool[] = [
	{
		name: "wait_for_learner",
		description:
			"End your reply and wait for the learner's next message, typed in the LearnHarness window. Returns what they wrote. " +
			"Every reply must end with this or with a question tool (or `problem` in practice) — never just stop.",
		inputSchema: Type.Object({}),
	},
	{
		name: "resume_session",
		description:
			"Re-read this session's state from LearnHarness: title, phase, the plan, and a compact recent history. " +
			"Call it when you start in a session that already has history, and after your context was compacted.",
		inputSchema: Type.Object({}),
	},
	{
		name: "set_title",
		description: "Name this session in the sidebar (a short topic title).",
		inputSchema: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }) }),
	},
];

/** Every tool Claude can call in a chat of this kind (union of its phases). */
export function listTools(chatId: string): ListedTool[] {
	const record = stores.chatStore.getChat(chatId);
	const phases: Phase[] = record?.kind === "practice" ? ["practice"] : record?.kind === "code" ? ["code"] : ["prober", "teacher"];
	const byName = new Map<string, ListedTool>();
	for (const phase of phases) {
		for (const tool of Object.values(phaseTools(chatId, phase))) {
			if (!byName.has(tool.name)) byName.set(tool.name, { name: tool.name, description: tool.description, inputSchema: tool.parameters as TSchema });
		}
	}
	for (const tool of BRIDGE_TOOLS) byName.set(tool.name, tool);
	if (record?.kind !== "practice") for (const tool of GRAPH_TOOLS) byName.set(tool.name, tool);
	if ((record?.kind ?? "teach") === "teach") for (const tool of CODING_TOOLS) byName.set(tool.name, tool);
	if (record?.kind !== "practice") for (const tool of TREE_TUTOR_TOOLS) byName.set(tool.name, tool);
	for (const tool of DELIVER_TOOLS) byName.set(tool.name, tool);
	return [...byName.values()];
}

export { validateArguments } from "../../agent/validate.ts";
import { validateArguments } from "../../agent/validate.ts";

// ─── native message shapes ─────────────────────────────────────────────────

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistantCall(toolCallId: string, name: string, args: unknown): LhMessage {
	return {
		id: newMessageId(),
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name, arguments: (args ?? {}) as Record<string, unknown> }],
		api: "anthropic-messages",
		provider: "claude-code",
		model: "claude-code",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as unknown as LhMessage;
}

function toolResultMessage(toolCallId: string, name: string, result: AgentToolResult<unknown>, isError: boolean): LhMessage {
	return {
		id: newMessageId(),
		role: "toolResult",
		toolCallId,
		toolName: name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	} as unknown as LhMessage;
}

function resultToWire(result: AgentToolResult<unknown>, isError: boolean): BridgeResult {
	const text: string[] = [];
	const images: { data: string; mimeType: string }[] = [];
	for (const part of result.content ?? []) {
		if (part.type === "text") text.push(part.text);
		else if (part.type === "image") images.push({ data: part.data, mimeType: part.mimeType });
	}
	return { text: text.join("\n") || (isError ? "Error" : "Done."), ...(images.length ? { images } : {}), ...(isError ? { isError } : {}) };
}

function errorResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} } as AgentToolResult<unknown>;
}

const STOPPED =
	"The learner stopped your reply in the LearnHarness window. Do not continue it: call wait_for_learner and respond to what they say next.";

// ─── resume_session ─────────────────────────────────────────────────────────

const RESUME_TAIL_CHARS = 12_000;
const LESSON_TAIL_CHARS = 6_000;

export function resumeText(record: ChatRecord): string {
	const phase = phaseOf(record);
	const lines = [`Session: ${record.title}`, `Kind: ${record.kind ?? "teach"} · phase: ${phase}`];
	if (record.tree) lines.push("", "Plan (author-once; progress derives from tagged quizzes):", "```json", JSON.stringify(record.tree.nodes ?? record.tree, null, 1), "```");
	const history = sessionMarkdown(record.messages);
	const tail = history.length > RESUME_TAIL_CHARS ? `…(earlier history omitted)…\n${history.slice(-RESUME_TAIL_CHARS)}` : history;
	lines.push("", "Recent history:", tail || "(none yet)");
	if (record.kind === "code") lines.push("", ...codingContext(record));
	const nodes = record.branchId ? readTree() : [];
	if (nodes.some((n) => n.id === record.branchId)) lines.push("", "Learning-tree branch (tree_branch shows it live):", outline(nodes, [record.branchId!]));
	return lines.join("\n");
}

/** A coding chat's workspace and the lesson it was opened from (its plan
 *  and recent history, shorter than this session's own). */
function codingContext(record: ChatRecord): string[] {
	const lines = [`Workspace: ${record.workspace ?? "(none)"}`];
	const lesson = record.lessonChatId ? stores.chatStore.getChat(record.lessonChatId) : null;
	if (!lesson) return [...lines, "Lesson: (not found)"];
	lines.push("", `Lesson this coding chat belongs to: ${lesson.title}`);
	if (lesson.tree) lines.push("Lesson plan:", "```json", JSON.stringify(lesson.tree.nodes ?? lesson.tree, null, 1), "```");
	const history = sessionMarkdown(lesson.messages);
	const tail = history.length > LESSON_TAIL_CHARS ? `…(earlier lesson history omitted)…\n${history.slice(-LESSON_TAIL_CHARS)}` : history;
	lines.push("", "Lesson recent history:", tail || "(none)");
	return lines;
}

// ─── the call ───────────────────────────────────────────────────────────────

/** Run one Claude tool call for a chat. Serialized per chat. */
export function callTool(chatId: string, name: string, rawArgs: unknown, signal: AbortSignal): Promise<BridgeResult> {
	const session = claudeSession(chatId);
	return serialized(session, () => runCall(session, chatId, name, rawArgs, signal));
}

async function runCall(session: ClaudeSession, chatId: string, name: string, rawArgs: unknown, signal: AbortSignal): Promise<BridgeResult> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return { text: `Unknown LearnHarness session ${chatId}.`, isError: true };

	if (name === "wait_for_learner") {
		session.stopRequested = false;
		const text = await block(session, "wait", signal);
		return { text: `The learner wrote:\n\n${text}` };
	}
	if (name === "resume_session") {
		// The record already holds anything queued — never hand it over twice.
		session.inbox = [];
		return { text: resumeText(record) };
	}
	if (name === "set_title") {
		const title = String((rawArgs as { title?: unknown })?.title ?? "").trim();
		if (!title) return { text: "set_title needs a non-empty title.", isError: true };
		stores.chatStore.renameChat(chatId, title.slice(0, 120));
		return { text: `Session titled "${title}".` };
	}

	const graph = await callGraphTool(chatId, name, rawArgs, signal);
	if (graph) return graph;

	const coding = callCodingTool(chatId, name, rawArgs);
	if (coding) return coding;

	const tree = callTreeTutorTool(record, name, rawArgs);
	if (tree) return tree;

	if (session.stopRequested) {
		session.stopRequested = false;
		return { text: STOPPED, isError: true };
	}

	const delivered = await callDeliverTool(chatId, name, rawArgs);
	if (delivered) return delivered;

	const phase = phaseOf(record);
	const tool = phaseTools(chatId, phase)[name];
	if (!tool) {
		const elsewhere = (["prober", "teacher", "practice", "code"] as Phase[]).find((p) => p !== phase && phaseTools(chatId, p)[name]);
		const why = elsewhere ? `"${name}" belongs to the ${elsewhere} phase; this session is in the ${phase} phase.` : `Unknown tool "${name}".`;
		return { text: why, isError: true };
	}

	const agent = startBridgeTurn(chatId);
	if (!agent) return { text: "Could not open a turn for this session.", isError: true };

	const toolCallId = `toolu_lh_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
	agent.push(assistantCall(toolCallId, name, rawArgs) as never);
	agent.emit({ type: "tool_execution_start", toolCallId, toolName: name, args: rawArgs } as never);

	const validated = validateArguments(tool, rawArgs);
	let result: AgentToolResult<unknown>;
	let isError: boolean;
	if (!validated.ok) {
		result = errorResult(validated.error);
		isError = true;
	} else {
		try {
			result = await tool.execute(toolCallId, validated.args as never, signal);
			isError = (result as { isError?: boolean }).isError === true;
		} catch (err) {
			result = errorResult(err instanceof Error ? err.message : String(err));
			isError = true;
		}
	}

	const isQuestion = (QUESTION_TOOLS as readonly string[]).includes(name);
	agent.emit({ type: "tool_execution_end", toolCallId, toolName: name, result, isError } as never);
	if (isQuestion && !isError) {
		// The question-stop rule: the call persists WITHOUT a result; the turn
		// settles; the learner's graded answer comes back as this call's result.
		const answer = await block(session, "question", signal, toolCallId);
		return { text: answer };
	}
	agent.push(toolResultMessage(toolCallId, name, result, isError) as never);
	const wire = resultToWire(result, isError);
	// Mid-reply composer input reaches Claude with its next result.
	if (session.inbox.length > 0) wire.text += `\n\n[While you were working, the learner wrote:]\n${session.inbox.splice(0).join("\n\n")}`;
	if (name === PRACTICE_PROBLEM_TOOL && !isError) {
		const work = await block(session, "problem", signal, toolCallId);
		return { ...wire, text: `${wire.text}\n\nThe learner responded:\n\n${work}` };
	}
	return wire;
}
