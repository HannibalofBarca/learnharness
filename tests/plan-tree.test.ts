/** Plan-tree tests (W1) — two layers: 1. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { type PlanToolResult } from "../src/core/contracts.ts";
import { createTree, PlanTreeError } from "../src/core/plan-tree.ts";
import { planTools } from "../src/agent/tools/plan.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

const N = (id: string, title = id, summary?: string) => ({ id, title, ...(summary ? { summary } : {}) });
const E = (from: string, to: string) => ({ from, to });


/** Assert the op throws a PlanTreeError matching the given regex. */
function assertReject(fn: () => unknown, needle: RegExp): void {
	try {
		fn();
	} catch (err) {
		assert.ok(err instanceof PlanTreeError, `expected PlanTreeError, got ${err}`);
		assert.match(err.message, needle);
		return;
	}
	assert.fail(`expected a PlanTreeError matching ${needle}, but the op succeeded`);
}

// ─── 1. pure ops ─────────────────────────────────────────────────────────────

describe("plan-tree pure ops", () => {
	it("createTree builds version 1 with no mutation of its inputs", () => {
		const nodes = [N("a", "A"), N("b", "B")];
		const edges = [E("a", "b")];
		const t = createTree(nodes, edges);
		assert.equal(t.version, 1);
		assert.ok(!("currentNodeId" in t), "no stored progress — structure only");
		assert.ok(!("doneNodeIds" in t), "no done ledger of any kind");
		assert.deepEqual(t.nodes.map((n) => n.id), ["a", "b"]);
		assert.deepEqual(t.edges, [E("a", "b")]);
		// Input arrays untouched (deep-copied into the tree).
		assert.deepEqual(nodes, [N("a", "A"), N("b", "B")]);
		assert.deepEqual(edges, [E("a", "b")]);
	});

	it("createTree rejects duplicate node ids", () => {
		assertReject(() => createTree([N("a"), N("a")], []), /Duplicate node id "a"/);
	});

	it("createTree rejects edges with missing endpoints", () => {
		assertReject(() => createTree([N("a")], [E("a", "ghost")]), /unknown node id "ghost"/);
		assertReject(() => createTree([N("a")], [E("ghost", "a")]), /unknown node id "ghost"/);
	});

	it("createTree rejects self-loops, duplicates, and cycles", () => {
		assertReject(() => createTree([N("a")], [E("a", "a")]), /self-loop/);
		assertReject(() => createTree([N("a"), N("b")], [E("a", "b"), E("a", "b")]), /already exists/);
		// a→b→c→a is a cycle.
		assertReject(
			() => createTree([N("a"), N("b"), N("c")], [E("a", "b"), E("b", "c"), E("c", "a")]),
			/cycle/,
		);
	});

	it("createTree rejects invalid node shapes", () => {
		assertReject(() => createTree([N("")], []), /non-empty `id`/);
		assertReject(() => createTree([{ id: "a", title: "" }], []), /non-empty `title`/);
	});

});

// ─── 2. tool execute against the real store ─────────────────────────────────

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

/** Call a plan tool's execute directly with a minimal execution-options object. */
async function exec(tools: ReturnType<typeof planTools>, name: string, input: unknown): Promise<PlanToolResult> {
	const t = tools[name]!;
	assert.ok(typeof t.execute === "function", `${name} must be a server-side tool with execute`);
	return t.execute("test", input).then((r) => r.details as PlanToolResult);
}

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

describe("plan_init — the author-once mermaid tool (execute against the real store)", () => {
	it("parses a mermaid block, builds the tree, persists, returns the full tree", async () => {
		const chatId = newChat("Plan: init");
		const tools = planTools({ chatId, chatStore });

		const res = await exec(tools, "plan_init", {
			mermaid: "graph TD\n  primitives[Number primitives] --> operators[Arithmetic operators]\n  operators --> expressions[Evaluating expressions]\n  detour[Side quest]\n",
		});
		assert.equal(res.ok, true);
		assert.equal(res.error, undefined);
		const tree = res.tree!;
		assert.equal(tree.version, 1);
		assert.deepEqual(
			tree.nodes.map((n) => n.id),
			["primitives", "operators", "expressions", "detour"],
		);
		assert.deepEqual(tree.edges, [
			{ from: "primitives", to: "operators" },
			{ from: "operators", to: "expressions" },
		]);

		const saved = chatStore.getChat(chatId)!.tree;
		assert.ok(saved, "tree persisted to the chat record");
		assert.deepEqual(saved, tree);
	});
});
