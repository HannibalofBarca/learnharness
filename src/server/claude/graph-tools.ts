/** The knowledge-graph tools (docs/claude-code-bridge.md §Background work): the tutor Claude plays the old extractor and auditor */

import * as crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import type { AgentTool } from "../../core/agent-types.ts";
import { Type, type TSchema } from "typebox";
import {
	asSessionFindings,
	auditSchema,
	AUDITOR_INSTRUCTIONS,
	EXTRACTOR_INSTRUCTIONS,
	fillAudit,
	fillFindings,
	fillNotesFindings,
	findingsSchema,
	NOTES_EXTRACTOR_INSTRUCTIONS,
	proseView,
	sessionFindingsSchema,
	sourceDigest,
	validateFindingsChains,
	validateSessionAnchors,
} from "../../agent/subagents/extraction.ts";
import { auditorGraphTools } from "../../agent/tools/graph.ts";
import { isProtectedPath, resolveSourcePath } from "../../agent/tools/fs-shared.ts";
import { batchRuns, coverageOf, messageViewLines } from "../../core/coverage.ts";
import { getGraph, mergeFindings } from "../../core/graph.ts";
import { settleGraphLayout } from "../../core/layout-settle.ts";
import { failedOutputCallIds } from "../../core/native-messages.ts";
import type { SessionFindings } from "../../core/contracts.ts";
import { effectiveSettings, stores } from "../stores.ts";
import { validateArguments, type BridgeResult, type ListedTool } from "./tools.ts";

interface PendingChat {
	kind: "chat";
	sourceId: string;
	batchIds: Set<string>;
	coverage: { fp: string; tokens: number }[];
	findings?: SessionFindings;
}
interface PendingNotes {
	kind: "notes";
	sourceId: string;
	filePath: string;
	importedAt: string;
	chunks: string[];
	index: number;
	findings?: SessionFindings;
}
type Pending = PendingChat | PendingNotes;

interface GraphBridgeGlobal {
	__lhGraphBridge?: Map<string, Pending>;
}
function pendingMap(): Map<string, Pending> {
	const g = globalThis as typeof globalThis & GraphBridgeGlobal;
	return (g.__lhGraphBridge ??= new Map());
}

const notesFindingsSchema = findingsSchema;

/** Notes uploaded through the import dialog wait here for the tutor (POST /api/graph/import; graph_import_notes with no path takes the oldest). */
const NOTES_QUEUE = path.join(PATHS.data, "claude", "notes-queue");

export function queueNotes(fileName: string, text: string): void {
	fs.mkdirSync(NOTES_QUEUE, { recursive: true });
	const safe = path.basename(fileName).replace(/[^A-Za-z0-9._ -]/g, "_") || "notes.txt";
	fs.writeFileSync(path.join(NOTES_QUEUE, `${Date.now()}-${safe}`), JSON.stringify({ fileName, text }), "utf-8");
}

function takeQueuedNotes(): { fileName: string; text: string } | null {
	let entries: string[];
	try {
		entries = fs.readdirSync(NOTES_QUEUE).sort();
	} catch {
		return null;
	}
	const first = entries[0];
	if (!first) return null;
	const file = path.join(NOTES_QUEUE, first);
	const queued = JSON.parse(fs.readFileSync(file, "utf-8")) as { fileName: string; text: string };
	fs.rmSync(file, { force: true });
	return queued;
}

const READERS = () => auditorGraphTools({ chatStore: stores.chatStore, graphStore: stores.graphStore });
const READER_NAMES: Record<string, string> = { graph_find: "find", graph_list_sessions: "list_sessions", graph_list_propositions: "list_propositions" };

export const GRAPH_TOOLS: ListedTool[] = [
	{
		name: "graph_extract_next",
		description:
			"Knowledge graph: get the next not-yet-extracted stretch of THIS session's teaching, with the extractor instructions. " +
			"Run it when a session ends (or the learner asks); repeat until it says nothing is left.",
		inputSchema: Type.Object({}),
	},
	{
		name: "graph_import_notes",
		description:
			"Knowledge graph: start importing a notes file — `path` (absolute, or relative to the learner's home), or no path for the next file the learner queued in the import dialog. Returns the first chunk with the extractor instructions.",
		inputSchema: Type.Object({ path: Type.Optional(Type.String({ minLength: 1 })) }),
	},
	{
		name: "graph_submit_findings",
		description: "Knowledge graph: submit the extractor findings for the current session stretch (propositions with messageId anchors + reasoning chains).",
		inputSchema: sessionFindingsSchema,
	},
	{
		name: "graph_submit_notes_findings",
		description: "Knowledge graph: submit the extractor findings for the current notes chunk (propositions + reasoning chains, no messageId).",
		inputSchema: notesFindingsSchema,
	},
	{
		name: "graph_submit_links",
		description: "Knowledge graph: submit the auditor's identity verdicts for the pending findings; the app merges them into the graph.",
		inputSchema: auditSchema,
	},
	...Object.entries(READER_NAMES).map(([name, inner]) => {
		const tool = READERS()[inner]!;
		return { name, description: `Knowledge graph (read-only): ${tool.description}`, inputSchema: tool.parameters as TSchema };
	}),
];

const chunkTokens = () => effectiveSettings().graph.extractionChunkTokens;

function chunkNotes(text: string, budget: number): string[] {
	if (text.trim().length === 0) return [];
	const out: string[] = [];
	let current = "";
	for (const line of text.split("\n")) {
		const candidate = current.length === 0 ? line : `${current}\n${line}`;
		if (current.length > 0 && Math.ceil(candidate.length / 4) > budget) {
			out.push(current);
			current = line;
		} else current = candidate;
	}
	if (current.trim().length > 0) out.push(current);
	return out;
}

function withDigest(sourceId: string, view: string): string {
	const digest = sourceDigest(getGraph(stores.graphStore), sourceId);
	return digest === "" ? view : `${digest}\n\n${view}`;
}

function nextChatStretch(chatId: string): BridgeResult {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return { text: "Unknown session.", isError: true };
	if (record.kind === "practice") return { text: "Practice sessions add nothing to the knowledge graph.", isError: true };
	const covered = coverageOf(record.messages, stores.graphStore.readCoverage(), chatId);
	if (covered.uncovered.length === 0) {
		pendingMap().delete(chatId);
		return { text: "Nothing left to extract from this session — the knowledge graph is up to date." };
	}
	const batch = batchRuns(covered.slots, covered.uncovered, chunkTokens())[0]!;
	const failed = failedOutputCallIds(record.messages);
	const messages = batch.map((slot) => slot.message);
	const view = proseView(messages, record.title, failed);
	const batchIds = new Set(messages.filter((m) => messageViewLines(m, m.id, failed).length > 0).map((m) => m.id));
	pendingMap().set(chatId, {
		kind: "chat",
		sourceId: chatId,
		batchIds,
		coverage: batch.filter((slot) => slot.tokens > 0).map((slot) => ({ fp: slot.fp, tokens: slot.tokens })),
	});
	return {
		text: `${EXTRACTOR_INSTRUCTIONS}\n\n---\n\n${withDigest(chatId, view)}\n\n---\n\nSubmit with graph_submit_findings.`,
	};
}

function notesChunkText(p: PendingNotes): string {
	const part = p.chunks.length > 1 ? ` (part ${p.index + 1}/${p.chunks.length})` : "";
	const view = `SOURCE (the author's personal notes): ${p.filePath}${part}\n\n${p.chunks[p.index]}`;
	return `${NOTES_EXTRACTOR_INSTRUCTIONS}\n\n---\n\n${withDigest(p.sourceId, view)}\n\n---\n\nSubmit with graph_submit_notes_findings.`;
}

async function importNotes(chatId: string, rawPath: string | undefined): Promise<BridgeResult> {
	let filePath: string;
	let text: string;
	if (!rawPath) {
		const queued = takeQueuedNotes();
		if (!queued) return { text: "No queued notes — pass a path, or ask the learner to upload files in the import dialog.", isError: true };
		filePath = queued.fileName;
		text = queued.text;
	} else {
		filePath = resolveSourcePath(rawPath);
		if (await isProtectedPath(filePath)) return { text: `Access denied: ${filePath} is a protected secret file.`, isError: true };
		try {
			text = fs.readFileSync(filePath, "utf-8");
		} catch (err) {
			return { text: `Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
	}
	const chunks = chunkNotes(text, chunkTokens());
	if (chunks.length === 0) return { text: `${filePath} is empty.`, isError: true };
	const sourceId = `src_${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
	const importedAt = new Date().toISOString();
	stores.graphStore.upsertSource({ id: sourceId, filePath, importedAt });
	const pending: PendingNotes = { kind: "notes", sourceId, filePath, importedAt, chunks, index: 0 };
	pendingMap().set(chatId, pending);
	return { text: notesChunkText(pending) };
}

function submitFindings(chatId: string, raw: unknown, notes: boolean): BridgeResult {
	const pending = pendingMap().get(chatId);
	if (!pending || (pending.kind === "notes") !== notes) {
		return { text: notes ? "No notes chunk is pending — call graph_import_notes first." : "No session stretch is pending — call graph_extract_next first.", isError: true };
	}
	const tool = { name: notes ? "graph_submit_notes_findings" : "graph_submit_findings", parameters: notes ? notesFindingsSchema : sessionFindingsSchema } as AgentTool<any>;
	const checked = validateArguments(tool, raw);
	if (!checked.ok) return { text: checked.error, isError: true };
	const existing = new Set(getGraph(stores.graphStore).nodes.map((n) => n.id));
	const value = notes ? fillNotesFindings(checked.args as never) : fillFindings(checked.args as never);
	const problem = notes
		? validateFindingsChains(value as never, existing)
		: validateSessionAnchors(value as never, (pending as PendingChat).batchIds) ?? validateFindingsChains(value as never, existing);
	if (problem) return { text: problem, isError: true };
	pending.findings = asSessionFindings(value as never);
	const propositions = pending.findings.propositions.map((p) => ({ id: p.id, name: p.name, statement: p.statement, aliases: p.aliases }));
	return {
		text:
			`${AUDITOR_INSTRUCTIONS}\n\n---\n\nProposed findings (propositions only):\n\n${JSON.stringify({ propositions }, null, 2)}\n\n` +
			`The current knowledge graph has ${existing.size} node(s). Explore it with graph_find / graph_list_sessions / graph_list_propositions, then submit with graph_submit_links.`,
	};
}

function submitLinks(chatId: string, raw: unknown): BridgeResult {
	const pending = pendingMap().get(chatId);
	if (!pending?.findings) return { text: "No findings are pending — submit findings first.", isError: true };
	const checked = validateArguments({ name: "graph_submit_links", parameters: auditSchema } as AgentTool<any>, raw);
	if (!checked.ok) return { text: checked.error, isError: true };
	const verdicts = fillAudit(checked.args as never);
	const foldedAt = new Date().toISOString();
	const stats =
		pending.kind === "chat"
			? mergeFindings(pending.sourceId, pending.findings, verdicts, { chatStore: stores.chatStore, graphStore: stores.graphStore }, {
					foldedAt,
					coverage: pending.coverage.map((c) => ({ chatId: pending.sourceId, fp: c.fp, tokens: c.tokens, foldedAt })),
				})
			: mergeFindings(pending.sourceId, pending.findings, verdicts, { chatStore: stores.chatStore, graphStore: stores.graphStore }, { foldedAt: pending.importedAt });
	settleGraphLayout(stores.graphStore);
	const merged = `Merged: ${stats.nodes} node(s), ${stats.chains ?? 0} chain(s).`;
	if (pending.kind === "notes") {
		pending.findings = undefined;
		pending.index += 1;
		if (pending.index < pending.chunks.length) return { text: `${merged}\n\nNext chunk:\n\n${notesChunkText(pending)}` };
		pendingMap().delete(chatId);
		return { text: `${merged} The notes file is fully imported.` };
	}
	pendingMap().delete(chatId);
	return { text: `${merged} Call graph_extract_next for the next stretch.` };
}

/** Handle a graph tool call, or undefined when `name` is not one. */
export async function callGraphTool(chatId: string, name: string, args: unknown, signal: AbortSignal): Promise<BridgeResult | undefined> {
	if (name === "graph_extract_next") return nextChatStretch(chatId);
	if (name === "graph_import_notes") {
		const raw = (args as { path?: unknown } | undefined)?.path;
		return importNotes(chatId, typeof raw === "string" && raw.trim() ? raw : undefined);
	}
	if (name === "graph_submit_findings") return submitFindings(chatId, args, false);
	if (name === "graph_submit_notes_findings") return submitFindings(chatId, args, true);
	if (name === "graph_submit_links") return submitLinks(chatId, args);
	const inner = READER_NAMES[name];
	if (!inner) return undefined;
	const tool = READERS()[inner]!;
	const checked = validateArguments(tool, args);
	if (!checked.ok) return { text: checked.error, isError: true };
	const result = await tool.execute(`graph_${Date.now()}`, checked.args as never, signal);
	const text = (result.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("\n");
	return { text: text || "(empty)" };
}
