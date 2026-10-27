/**
 * The Claude Code bridge core (docs/claude-code-bridge.md), zero tokens: a
 * scripted "Claude" drives the MCP-side callTool while the learner's inputs
 * go through the real handleChatInput — the same seams the MCP route and
 * POST /api/chat use.
 *
 * Runs under an isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bridge-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_UPDATE_FLUSH_MS = "1";

const { chatStore } = await import("../src/store/chats.ts");
const { callTool, listTools, validateArguments, phaseTools } = await import("../src/server/claude/tools.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { claudeSession } = await import("../src/server/claude/session.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { handleClaudeHook } = await import("../src/server/claude/hook.ts");
const { bridgeToken } = await import("../src/server/claude/token.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const never = new AbortController().signal;

async function settle(): Promise<void> {
	for (let i = 0; i < 50 && [...chatIds].some((id) => isTurnRunning(id)); i++) await new Promise((r) => setTimeout(r, 5));
}
const chatIds = new Set<string>();
function newChat(kind?: "practice") {
	const chat = chatStore.createChat("test", kind);
	chatIds.add(chat.id);
	return chat.id;
}
const roles = (id: string) => chatStore.getChat(id)!.messages.map((m) => (m as { role: string }).role);

const probeArgs = {
	question: "What is $\\frac{d}{dx}x^2$?",
	options: [
		{ label: "$2x$", value: "a" },
		{ label: "$x$", value: "b" },
		{ label: "$x^2$", value: "c" },
	],
	explanation: "Power rule: bring the exponent down.",
	correctAnswer: "a",
};

describe("claude bridge", () => {
	it("lists the prober and teacher tools plus the bridge tools, never the replaced ones", () => {
		const id = newChat();
		const names = listTools(id).map((t) => t.name);
		for (const name of ["send_to_user", "probe", "ask_user_question", "probe_done", "quiz", "plan_init", "wait_for_learner", "resume_session", "set_title"]) {
			assert.ok(names.includes(name), `${name} listed`);
		}
		for (const name of ["read", "ls", "find", "grep", "research", "demo", "visual", "pdf"]) assert.ok(!names.includes(name), `${name} not listed`);
	});

	it("wait_for_learner returns text the learner sent before Claude asked", async () => {
		const id = newChat();
		const res = await handleChatInput(id, { type: "text", text: "teach me derivatives" });
		assert.equal(((await res.json()) as { queued?: boolean }).queued, true);
		const result = await callTool(id, "wait_for_learner", {}, never);
		assert.match(result.text, /teach me derivatives/);
		assert.deepEqual(roles(id), ["user"]);
	});

	it("send_to_user streams into a turn and persists as a native tool call + result", async () => {
		const id = newChat();
		const result = await callTool(id, "send_to_user", { message: "Hello **learner**" }, never);
		assert.ok(!result.isError, result.text);
		assert.ok(isTurnRunning(id), "a turn opened for Claude's output");
		const waiting = callTool(id, "wait_for_learner", {}, never);
		for (let i = 0; i < 100 && !claudeSession(id).blocked; i++) await new Promise((r) => setTimeout(r, 5));
		await settle();
		assert.ok(!isTurnRunning(id), "blocking settled the turn");
		assert.deepEqual(roles(id), ["assistant", "toolResult"]);
		const call = (chatStore.getChat(id)!.messages[0] as { content: { type: string; name: string }[] }).content[0]!;
		assert.equal(call.type, "toolCall");
		assert.equal(call.name, "send_to_user");
		await handleChatInput(id, { type: "text", text: "ok" });
		assert.match((await waiting).text, /ok/);
		void callTool(id, "wait_for_learner", {}, never);
		await settle();
	});

	it("a question persists without a result, settles the turn, and the answer returns to Claude", async () => {
		const id = newChat();
		const pending = callTool(id, "probe", probeArgs, never);
		for (let i = 0; i < 100 && !claudeSession(id).blocked; i++) await new Promise((r) => setTimeout(r, 5));
		await settle();
		assert.ok(!isTurnRunning(id));
		assert.deepEqual(roles(id), ["assistant"], "question call persisted, no placeholder result");
		const callId = (chatStore.getChat(id)!.messages[0] as { content: { id: string }[] }).content[0]!.id;
		assert.equal(claudeSession(id).blocked?.toolCallId, callId);
		const answer = { kind: "quiz", tool: "probe", answers: [{ label: "$2x$", value: "a", index: 1 }], correct: true, confidence: 80 };
		const res = await handleChatInput(id, { type: "answer", toolCallId: callId, answer: answer as never });
		assert.equal(res.status, 200);
		const back = await pending;
		assert.match(back.text, /Learner's response to probe/);
		assert.match(back.text, /"correct":true/);
		assert.deepEqual(roles(id), ["assistant", "toolResult"]);
		assert.ok(isTurnRunning(id), "the answer opened a turn for Claude's reaction");
		runningTurn(id)?.abort();
		await settle();
	});

	it("invalid arguments come back as a retryable error and persist as an error result", async () => {
		const id = newChat();
		const result = await callTool(id, "probe", { question: "x" }, never);
		assert.equal(result.isError, true);
		assert.match(result.text, /Validation failed/);
		runningTurn(id)?.abort();
		await settle();
		assert.deepEqual(roles(id), ["assistant", "toolResult"]);
	});

	it("teacher tools are refused before probe_done", async () => {
		const id = newChat();
		const result = await callTool(id, "plan_init", { mermaid: "graph TD\nA-->B" }, never);
		assert.equal(result.isError, true);
		assert.match(result.text, /teacher phase/);
	});

	it("a learner stop refuses Claude's next output once", async () => {
		const id = newChat();
		await callTool(id, "send_to_user", { message: "part 1" }, never);
		runningTurn(id)?.abort();
		await settle();
		const refused = await callTool(id, "send_to_user", { message: "part 2" }, never);
		assert.equal(refused.isError, true);
		assert.match(refused.text, /stopped your reply/);
		const ok = await callTool(id, "send_to_user", { message: "after" }, never);
		assert.ok(!ok.isError);
		runningTurn(id)?.abort();
		await settle();
	});

	it("validateArguments heals JSON-string options like the engine did", () => {
		const probe = phaseTools("x", "prober").probe!;
		const v = validateArguments(probe, { ...probeArgs, options: JSON.stringify(probeArgs.options) });
		assert.ok(v.ok);
	});

	it("the Stop hook blocks a bare stop once, then lets Claude stop", async () => {
		const id = newChat();
		const hook = (body: object, token = bridgeToken()) =>
			handleClaudeHook(new Request(`http://127.0.0.1/api/claude/hook?chat=${id}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
		assert.equal((await hook({}, "wrong")).status, 401);
		const first = (await (await hook({ session_id: "s1", stop_hook_active: false })).json()) as { decision?: string };
		assert.equal(first.decision, "block");
		const second = (await (await hook({ session_id: "s1", stop_hook_active: true })).json()) as { decision?: string };
		assert.equal(second.decision, undefined);
	});
	it("graph tools: extract a session stretch, submit findings + links, merge into the graph", async () => {
		const id = newChat();
		await callTool(id, "send_to_user", { message: "The derivative of $x^2$ is $2x$ because the secant slope $(2x+h)$ tends to $2x$ as $h \to 0$." }, never);
		runningTurn(id)?.abort();
		await settle();
		const stretch = await callTool(id, "graph_extract_next", {}, never);
		assert.ok(!stretch.isError, stretch.text);
		const anchor = /TEACHER \[([^\]]+)\]/.exec(stretch.text)?.[1];
		assert.ok(anchor, "the view labels teacher passages with their message id");
		const bad = await callTool(id, "graph_submit_findings", { propositions: [{ id: "p1", name: "power rule", statement: "d/dx x^2 = 2x", messageId: "nope" }], chains: [] }, never);
		assert.equal(bad.isError, true, "an anchor outside the stretch is refused");
		const audit = await callTool(id, "graph_submit_findings", {
			propositions: [
				{ id: "p1", name: "secant slope", statement: "The secant slope of x^2 over [x, x+h] is 2x+h.", messageId: anchor },
				{ id: "p2", name: "derivative of x^2", statement: "The derivative of x^2 is 2x.", messageId: anchor },
			],
			chains: [{ premises: ["p1"], conclusion: "p2" }],
		}, never);
		assert.ok(!audit.isError, audit.text);
		assert.match(audit.text, /graph_submit_links/);
		const merged = await callTool(id, "graph_submit_links", { links: [] }, never);
		assert.match(merged.text, /Merged: 2 node/);
		const again = await callTool(id, "graph_extract_next", {}, never);
		assert.match(again.text, /Nothing left/);
		const { stores } = await import("../src/server/stores.ts");
		assert.ok(stores.graphStore.readNodes().length >= 2);
	});
	it("deliver_research writes a finished research job into the lesson", async () => {
		const id = newChat();
		const out = await callTool(id, "deliver_research", { question: "Who first wrote d/dx?", brief: "Leibniz, 1675 [1].", sources: [{ title: "History", url: "https://example.org" }] }, never);
		assert.ok(!out.isError, out.text);
		runningTurn(id)?.abort();
		await settle();
		const messages = chatStore.getChat(id)!.messages as unknown as { role: string; customType?: string; content: unknown }[];
		assert.deepEqual(messages.map((m) => m.customType ?? m.role), ["assistant", "toolResult", "subagent-steer"]);
		const { stores } = await import("../src/server/stores.ts");
		const jobs = stores.jobStore.listJobs(id);
		assert.equal(jobs.length, 1);
		assert.equal(jobs[0]!.status, "done");
	});
	it("the launch: both phases in one method prompt, restricted flags, deny rules, token-carrying MCP config", async () => {
		const { bridgePrompt, claudeLaunch } = await import("../src/server/claude/launch.ts");
		const teach = bridgePrompt("teach");
		assert.match(teach, /You are the LearnHarness tutor/);
		assert.ok(teach.indexOf("Phase 1 — PROBING") < teach.indexOf("Phase 2 — TEACHING"));
		assert.doesNotMatch(bridgePrompt("practice"), /Phase 1 — PROBING/);
		const id = newChat();
		const launch = claudeLaunch(id, "http://127.0.0.1:4321")!;
		assert.equal(launch.resumeArgs, undefined, "nothing to resume before the Stop hook records a conversation");
		for (const flag of ["--restricted", "--strict-mcp-config", "--append-system-prompt-file", "--session-id"]) assert.ok(launch.freshArgs.includes(flag), flag);
		assert.ok(!launch.freshArgs.includes("--bare"), "--bare would refuse the subscription login");
		const tools = launch.freshArgs[launch.freshArgs.indexOf("--tools") + 1]!;
		assert.ok(tools.includes("mcp__learnharness__wait_for_learner"));
		assert.ok(!/Bash|Edit|Write/.test(tools), tools);
		const settings = JSON.parse(fs.readFileSync(launch.freshArgs[launch.freshArgs.indexOf("--settings") + 1]!, "utf-8"));
		assert.equal(settings.autoMemoryEnabled, false);
		assert.equal(settings.disableClaudeAiConnectors, true);
		assert.ok(settings.permissions.deny.some((r: string) => r.startsWith("Read(//") && r.endsWith("/**)")), "the data dir is denied");
		const mcp = JSON.parse(fs.readFileSync(launch.freshArgs[launch.freshArgs.indexOf("--mcp-config") + 1]!, "utf-8"));
		assert.equal(mcp.mcpServers.learnharness.url, `http://127.0.0.1:4321/api/mcp?chat=${id}`);
		assert.equal(mcp.mcpServers.learnharness.headers.Authorization, `Bearer ${bridgeToken()}`);
		await handleClaudeHook(new Request(`http://127.0.0.1/api/claude/hook?chat=${id}`, { method: "POST", headers: { authorization: `Bearer ${bridgeToken()}` }, body: JSON.stringify({ session_id: "conv-1", stop_hook_active: true }) }));
		assert.ok(claudeLaunch(id, "http://127.0.0.1:4321")!.resumeArgs?.includes("conv-1"), "the hook-recorded conversation resumes");
	});
	it("the planner: saves plans, opens topic sessions with the plan context, launches unrestricted", async () => {
		const { callPlannerTool, plannerLaunch, listPlans } = await import("../src/server/claude/planner.ts");
		const saved = await callPlannerTool("plan_save", { title: "Calculus", markdown: "# Goals\nUnderstand derivatives.", topics: [{ title: "Limits", goal: "Know what a limit is" }, { title: "Derivatives", goal: "Derive x^2" }] }, never);
		assert.ok(!saved.isError, saved.text);
		const plan = listPlans().find((p) => p.title === "Calculus")!;
		assert.equal(plan.topics.length, 2);
		const opened = await callPlannerTool("session_open", { planId: plan.id, topicIndex: 1 }, never);
		assert.ok(!opened.isError, opened.text);
		const reread = listPlans().find((p) => p.id === plan.id)!;
		const chat = chatStore.getChat(reread.topics[1]!.sessionId!)!;
		assert.equal(chat.title, "Derivatives");
		assert.match(String((chat.messages[0] as { content: unknown }).content), /Goal: Derive x\^2[\s\S]*Understand derivatives/);
		const resaved = await callPlannerTool("plan_save", { id: plan.id, title: "Calculus", markdown: "v2", topics: [{ title: "Derivatives", goal: "Derive x^2" }] }, never);
		assert.ok(!resaved.isError);
		assert.equal(listPlans().find((p) => p.id === plan.id)!.topics[0]!.sessionId, chat.id, "a topic keeps its session across re-saves");
		const launch = plannerLaunch("http://127.0.0.1:4321");
		assert.ok(!launch.freshArgs.includes("--restricted") && !launch.freshArgs.includes("--strict-mcp-config"), "the planner is the learner's normal Claude Code");
		assert.ok(launch.freshArgs.includes("--append-system-prompt-file"));
	});
});

