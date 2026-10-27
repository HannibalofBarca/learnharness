/**
 * The Planner (ClaudeHarness): a home-level Claude Code — the learner's own,
 * UNRESTRICTED (it is also their coding agent) — with LearnHarness planning
 * tools on top. It reads the learner's docs, writes learning plans, and
 * opens teaching sessions from them, at its and the learner's discretion.
 *
 * Plans are plain JSON records in data/plans/<id>.json. The planner's MCP
 * endpoint is /api/mcp?chat=planner (same bridge token).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { PATHS, ROOT } from "../../../config.ts";
import { newUserMessage } from "../../core/native-messages.ts";
import type { AgentTool } from "../../core/agent-types.ts";
import { stores } from "../stores.ts";
import { bridgeToken } from "./token.ts";
import { callGraphTool, GRAPH_TOOLS } from "./graph-tools.ts";
import { validateArguments } from "../../agent/validate.ts";
import type { BridgeResult, ListedTool } from "./tools.ts";

export const PLANNER_ID = "planner";

export interface PlanTopic {
	title: string;
	goal: string;
	/** The teaching session opened for this topic, once there is one. */
	sessionId?: string;
}

export interface Plan {
	id: string;
	title: string;
	/** The plan itself, Markdown: goals, sequencing, reasoning. */
	markdown: string;
	topics: PlanTopic[];
	createdAt: string;
	updatedAt: string;
}

const PLANS_DIR = path.join(PATHS.data, "plans");

function planFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid plan id: ${id}`);
	return path.join(PLANS_DIR, `${id}.json`);
}

export function listPlans(): Plan[] {
	let names: string[];
	try {
		names = fs.readdirSync(PLANS_DIR).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
	return names
		.flatMap((n) => {
			try {
				return [JSON.parse(fs.readFileSync(path.join(PLANS_DIR, n), "utf-8")) as Plan];
			} catch {
				return [];
			}
		})
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getPlan(id: string): Plan | null {
	try {
		return JSON.parse(fs.readFileSync(planFile(id), "utf-8")) as Plan;
	} catch {
		return null;
	}
}

function writePlan(plan: Plan): void {
	fs.mkdirSync(PLANS_DIR, { recursive: true });
	fs.writeFileSync(planFile(plan.id), JSON.stringify(plan, null, "\t"), "utf-8");
}

export function deletePlan(id: string): boolean {
	try {
		fs.rmSync(planFile(id));
		return true;
	} catch {
		return false;
	}
}

/** Open a teaching session for a plan topic: a new chat whose first learner
 *  message carries the topic, its goal and the plan's context. */
export function openTopicSession(planId: string, topicIndex: number): { chatId: string } | { error: string } {
	const plan = getPlan(planId);
	const topic = plan?.topics[topicIndex];
	if (!plan || !topic) return { error: "Unknown plan or topic." };
	if (topic.sessionId && stores.chatStore.getChat(topic.sessionId)) return { chatId: topic.sessionId };
	const chat = stores.chatStore.createChat(topic.title);
	const message = newUserMessage(
		`${topic.title}\n\nGoal: ${topic.goal}\n\n(Part of my learning plan "${plan.title}". The plan, for context:)\n\n${plan.markdown}`,
	);
	stores.chatStore.saveMessages(chat.id, [message]);
	topic.sessionId = chat.id;
	plan.updatedAt = new Date().toISOString();
	writePlan(plan);
	return { chatId: chat.id };
}

// ─── the planner's tools ────────────────────────────────────────────────────

const topicSchema = Type.Object({ title: Type.String({ minLength: 1 }), goal: Type.String({ minLength: 1 }) });
const SCHEMAS = {
	plan_list: Type.Object({}),
	plan_get: Type.Object({ id: Type.String() }),
	plan_save: Type.Object({
		id: Type.Optional(Type.String({ description: "Omit to create a new plan; pass an id to replace that plan." })),
		title: Type.String({ minLength: 1 }),
		markdown: Type.String({ minLength: 1, description: "The plan: goals, the order of topics and why, milestones. Markdown + LaTeX." }),
		topics: Type.Array(topicSchema, { description: "The ordered topics; each can become a teaching session." }),
	}),
	plan_delete: Type.Object({ id: Type.String() }),
	session_open: Type.Object({
		planId: Type.String(),
		topicIndex: Type.Integer({ minimum: 0, description: "0-based index into the plan's topics." }),
	}),
	sessions_list: Type.Object({}),
};

export const PLANNER_TOOLS: ListedTool[] = [
	{ name: "plan_list", description: "List the learner's learning plans (id, title, topics with their sessions).", inputSchema: SCHEMAS.plan_list },
	{ name: "plan_get", description: "Read one plan in full.", inputSchema: SCHEMAS.plan_get },
	{ name: "plan_save", description: "Create or replace a learning plan. It shows on the Planner page; topics keep their sessions when titles match.", inputSchema: SCHEMAS.plan_save },
	{ name: "plan_delete", description: "Delete a plan (its sessions stay).", inputSchema: SCHEMAS.plan_delete },
	{ name: "session_open", description: "Open a teaching session for a plan topic (the tutor gets the topic, goal and plan). Returns the session id.", inputSchema: SCHEMAS.session_open },
	{ name: "sessions_list", description: "List the learner's existing sessions (id, title, kind, last update).", inputSchema: SCHEMAS.sessions_list },
	...GRAPH_TOOLS.filter((t) => t.name === "graph_import_notes" || t.name === "graph_submit_notes_findings" || t.name === "graph_submit_links" || t.name.startsWith("graph_list") || t.name === "graph_find"),
];

export async function callPlannerTool(name: string, raw: unknown, signal: AbortSignal): Promise<BridgeResult> {
	const schema = (SCHEMAS as Record<string, (typeof SCHEMAS)[keyof typeof SCHEMAS]>)[name];
	if (!schema) {
		const graph = await callGraphTool(PLANNER_ID, name, raw, signal);
		return graph ?? { text: `Unknown tool "${name}".`, isError: true };
	}
	const checked = validateArguments({ name, parameters: schema } as AgentTool<any>, raw);
	if (!checked.ok) return { text: checked.error, isError: true };
	const args = checked.args as Record<string, never>;
	if (name === "plan_list") return { text: JSON.stringify(listPlans().map((p) => ({ id: p.id, title: p.title, topics: p.topics })), null, 1) };
	if (name === "plan_get") {
		const plan = getPlan(String(args.id));
		return plan ? { text: JSON.stringify(plan, null, 1) } : { text: "No such plan.", isError: true };
	}
	if (name === "plan_save") {
		const input = args as unknown as { id?: string; title: string; markdown: string; topics: { title: string; goal: string }[] };
		const now = new Date().toISOString();
		const prior = input.id ? getPlan(input.id) : null;
		if (input.id && !prior) return { text: `No plan ${input.id} — omit id to create one.`, isError: true };
		const sessions = new Map((prior?.topics ?? []).map((t) => [t.title, t.sessionId]));
		const plan: Plan = {
			id: prior?.id ?? `plan_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
			title: input.title,
			markdown: input.markdown,
			topics: input.topics.map((t) => ({ ...t, ...(sessions.get(t.title) ? { sessionId: sessions.get(t.title) } : {}) })),
			createdAt: prior?.createdAt ?? now,
			updatedAt: now,
		};
		writePlan(plan);
		return { text: `Saved plan ${plan.id} ("${plan.title}", ${plan.topics.length} topics). It is on the Planner page.` };
	}
	if (name === "plan_delete") return deletePlan(String(args.id)) ? { text: "Deleted." } : { text: "No such plan.", isError: true };
	if (name === "session_open") {
		const out = openTopicSession(String(args.planId), Number(args.topicIndex));
		return "error" in out ? { text: out.error, isError: true } : { text: `Session ${out.chatId} is open in the sidebar; the learner starts it by opening it.` };
	}
	if (name === "sessions_list") {
		return { text: JSON.stringify(stores.chatStore.listChats().map((c) => ({ id: c.id, title: c.title, kind: c.kind, updatedAt: c.updatedAt })), null, 1) };
	}
	return { text: `Unknown tool "${name}".`, isError: true };
}

// ─── the planner's launch ───────────────────────────────────────────────────

const PLANNER_PROMPT = `# You are the LearnHarness Planner

You run inside LearnHarness, a learning app, as the learner's high-level planner — and you are also their normal Claude Code (coding included, if they ask: the app's source is yours to work on with them).

Planning:
- Help the learner turn their goals and existing documents into learning plans. Read their docs yourself (Read/Glob/Grep); ask where they are if you don't know.
- Save plans with plan_save (several are fine — one per subject, course or goal; your and the learner's call). Each plan: Markdown reasoning (goals, why this order, milestones) plus ordered topics with a goal each. Plans show on the Planner page.
- Open teaching sessions for topics with session_open when it makes sense (or the learner starts them from the Planner page). Each session's tutor teaches one topic with the LearnHarness method.
- Keep plans current: sessions_list shows what was studied; update plans as the learner progresses.
- Their docs can also go into the knowledge graph (graph_import_notes, then the findings/links tools) if they want them connected to their learning history.
- Talk with the learner right here in this terminal.`;

export interface PlannerLaunch {
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
	// Working directory: the app's source when running from it (so "mess
	// with the app" works), otherwise the learner's home.
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
