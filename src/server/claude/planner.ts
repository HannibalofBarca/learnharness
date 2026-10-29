/** The Planner (ClaudeHarness): a home-level Claude Code — the learner's own, UNRESTRICTED (it is also their coding agent) */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { PATHS, ROOT } from "../../../config.ts";
import { stores } from "../stores.ts";
import { bridgeToken } from "./token.ts";
import { callGraphTool, GRAPH_TOOLS } from "./graph-tools.ts";
import { callTreePlannerTool, TREE_PLANNER_TOOLS } from "./learning-tree.ts";
import type { BridgeResult, ListedTool } from "./tools.ts";

export const PLANNER_ID = "planner";

const SCHEMAS = {
	sessions_list: Type.Object({}),
};

export const PLANNER_TOOLS: ListedTool[] = [
	...TREE_PLANNER_TOOLS,
	{ name: "sessions_list", description: "List the learner's existing sessions (id, title, kind, last update).", inputSchema: SCHEMAS.sessions_list },
	...GRAPH_TOOLS.filter((t) => t.name === "graph_import_notes" || t.name === "graph_submit_notes_findings" || t.name === "graph_submit_links" || t.name.startsWith("graph_list") || t.name === "graph_find"),
];

export async function callPlannerTool(name: string, raw: unknown, signal: AbortSignal): Promise<BridgeResult> {
	const tree = callTreePlannerTool(name, raw);
	if (tree) return tree;
	if (name === "sessions_list") {
		return { text: JSON.stringify(stores.chatStore.listChats().map((c) => ({ id: c.id, title: c.title, kind: c.kind, updatedAt: c.updatedAt })), null, 1) };
	}
	const graph = await callGraphTool(PLANNER_ID, name, raw, signal);
	return graph ?? { text: `Unknown tool "${name}".`, isError: true };
}

// ─── the planner's launch ───────────────────────────────────────────────────

const PLANNER_PROMPT = `# You are the LearnHarness Planner

You run inside LearnHarness, a learning app, as the learner's high-level planner — and you are also their normal Claude Code (coding included, if they ask: the app's source is yours to work on with them).

Planning — the learning tree (shown as a canvas on the Planner page):
- One tree of everything the learner studies: Academia → focus areas → documents/courses → major branches. You own this trunk and the major branches; teaching sessions grow the sub-branches and leaf topics and mark their progress. Build it from their documents (Read/Glob/Grep); ask where they are if you don't know.
- A topic exists once: the same topic under several purviews is ONE node with several parents (tree_upsert with an existing title adds parents, never a copy), so progress is shared.
- Node kinds: group (purview/branch), concept (taught), practice (coded or drilled — solvers, controllers, homeworks). Note each node's source (document + section).
- Open teaching sessions on branches with tree_open_session when it makes sense (the learner can also start them from the canvas). Keep the trunk current: tree_get and sessions_list show what was studied.
- Their docs can also go into the knowledge graph (graph_import_notes, then the findings/links tools) if they want them connected to their learning history.
- Talk with the learner right here in this terminal.`;

interface PlannerLaunch {
	cwd: string;
	command: string;
	resumeArgs?: string[];
	freshArgs: string[];
}

export function plannerLaunch(origin: string): PlannerLaunch {
	const dir = path.join(PATHS.data, "claude", PLANNER_ID);
	fs.mkdirSync(dir, { recursive: true });
	const token = bridgeToken();
	const promptFile = path.join(dir, "planner.md");
	fs.writeFileSync(promptFile, PLANNER_PROMPT, "utf-8");
	const mcpFile = path.join(dir, "mcp.json");
	fs.writeFileSync(
		mcpFile,
		JSON.stringify({ mcpServers: { learnharness: { type: "http", url: `${origin}/api/mcp?chat=${PLANNER_ID}`, headers: { Authorization: `Bearer ${token}` } } } }, null, "\t"),
		{ mode: 0o600 },
	);
	const settingsFile = path.join(dir, "settings.json");
	const hookUrl = `${origin}/api/claude/hook?chat=${PLANNER_ID}`;
	fs.writeFileSync(
		settingsFile,
		JSON.stringify({
			permissions: { allow: PLANNER_TOOLS.map((t) => `mcp__learnharness__${t.name}`) },
			hooks: { Stop: [{ hooks: [{ type: "command", command: `curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data-binary @- "${hookUrl}"` }] }] },
		}, null, "\t"),
		{ mode: 0o600 },
	);
	// Working directory: the app's source when running from it (so "mess with the app" works), otherwise the learner's home.
	const source = fs.existsSync(path.join(ROOT, ".git")) ? ROOT : os.homedir();
	const common = ["--mcp-config", mcpFile, "--settings", settingsFile, "--append-system-prompt-file", promptFile];
	const existing = readPlannerSession();
	return {
		cwd: source,
		command: "claude",
		...(existing ? { resumeArgs: [...common, "--resume", existing] } : {}),
		freshArgs: [...common, "--session-id", randomUUID()],
	};
}

const PLANNER_SESSION = path.join(PATHS.data, "claude", PLANNER_ID, "session");

function readPlannerSession(): string | null {
	try {
		return fs.readFileSync(PLANNER_SESSION, "utf-8").trim() || null;
	} catch {
		return null;
	}
}

export function rememberPlannerSession(sessionId: string): void {
	fs.mkdirSync(path.dirname(PLANNER_SESSION), { recursive: true });
	fs.writeFileSync(PLANNER_SESSION, sessionId, "utf-8");
}
