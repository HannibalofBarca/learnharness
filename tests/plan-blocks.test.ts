/** plan-blocks — the INTERIM plan presentation seam (docs/probe-teach-split.md §6): the full block renders IN FLOW exactly once */
import assert from "node:assert";
import test from "node:test";
import type { PlanTree } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { planBlocksFor } from "../src/core/plan-blocks.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import type { PlanBlockData } from "../src/core/contracts.ts";

// 5-node fixture: a → b → c, b → d, d → e.
const TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "A" },
		{ id: "b", title: "B" },
		{ id: "c", title: "C" },
		{ id: "d", title: "D" },
		{ id: "e", title: "E" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
		{ from: "b", to: "d" },
		{ from: "d", to: "e" },
	],
	version: 1,
};


/** A native assistant message with one tool call (the projection's tool part source) — minimal fixture shape, same as the record holds. */
function assistantWithCall(id: string, name: string, args: unknown, ...text: string[]): LhMessage {
	const content: unknown[] = [];
	for (const t of text) content.push({ type: "text", text: t });
	content.push({ type: "toolCall", id: `call_${id}`, name, arguments: args as never });
	return {
		id,
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}

/** A native tool result for a call (details = what the record + projection read; the plan tool persists {ok, tree} here). */
function resultOf(callId: string, toolName: string, details: unknown, isError = false): LhMessage {
	return {
		id: `r_${callId}${isError ? "_e" : ""}`,
		role: "toolResult",
		toolCallId: `call_${callId}`,
		toolName,
		content: [{ type: "text", text: isError ? "failed" : "ok" }],
		details,
		isError,
		timestamp: Date.now(),
	} as never;
}

/** Emit + persist + project: the full persistTurn slice for a turn whose new messages are `turn`, run over `record`. */
function projectAfter(record: LhMessage[], turn: LhMessage[], tree: PlanTree | null) {
	// Wave D: the status derivation reads the NATIVE transcript.
	const blocks = planBlocksFor(record, turn, tree, [...record, ...turn]);
	return projectNative([...record, ...turn, ...blocks]);
}

function blocksOf(messages: ReturnType<typeof projectNative>): PlanBlockData[] {
	return messages.flatMap((m) =>
		(m.parts as { type: string; data?: PlanBlockData }[])
			.filter((p) => p.type === "data-plan-block")
			.map((p) => p.data!),
	);
}

test("a successful plan_init turn gains ONE full block (all nodes, statuses from the transcript)", () => {
	const turn = [
		assistantWithCall("m1", "plan_init", { tree: TREE }, "Here is the plan."),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
	];
	const out = projectAfter([], turn, TREE);
	const blocks = blocksOf(out);
	assert.equal(blocks.length, 1);
	const data = blocks[0]!;
	assert.equal(data.kind, "full");
	assert.equal(data.current, null, "at authoring nothing is current");
	assert.equal(data.nodes.length, 5);
	assert.ok(data.nodes.every((n) => n.status === "upcoming"));
	assert.equal(data.edges.length, 4);
});

test("a FAILED plan_init gains nothing", () => {
	const turn = [
		assistantWithCall("m1", "plan_init", { tree: TREE }, "oops"),
		resultOf("m1", "plan_init", { ok: false, error: "bad" }, true),
	];
	assert.equal(blocksOf(projectAfter([], turn, TREE)).length, 0);
});

test("idempotent — a call whose block the record already carries is never re-emitted", () => {
	const turn = [
		assistantWithCall("m1", "plan_init", { tree: TREE }),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
	];
	const first = projectAfter([], turn, TREE);
	assert.equal(blocksOf(first).length, 1);
	// Persist replay: the same turn's messages land again over a record that already emitted the marker → no duplicate.
	const record: LhMessage[] = [...turn, ...planBlocksFor([], turn, TREE, turn)];
	const blocks2 = planBlocksFor(record, turn, TREE, record);
	assert.equal(blocks2.length, 0, "no duplicate block on persist replay");
});
