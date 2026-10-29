// THE PROBER'S GRAPH TOOLS — pinned behaviors: 1.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools } from "../src/agent/tools.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import type { ChatSummary } from "../src/core/contracts/chat.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
const node = (
	id: string,
	name: string,
	provenance: Array<{ chatId: string; messageId: string }>,
): GraphNode => ({
	id,
	name,
	statement: `statement of ${name}`, // must NEVER leak into tool output
	aliases: [],
	createdAt: "2026-09-23T00:00:00.000Z",
	provenance,
});

function fakeStores(
	nodes: GraphNode[],
	over: {
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
	} = {},
): { chatStore: ChatStore; graphStore: GraphStore } {
	const chains: GraphChain[] = [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readChains: () => chains,
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
		readPositions: () => ({}),
		writePositions: () => {},
		readClusterLabels: () => [],
		appendClusterLabel: () => {},
		appendNamingRun: () => {},
	} as unknown as GraphStore;
	const chatStore: ChatStore = {
		listChats: () =>
			(over.chats ?? []).map((c) => ({ ...c, messageCount: 0 }) as unknown as ChatSummary),
		getChat: (id: string) =>
			((over.chats ?? []).find((c) => c.id === id) as unknown as ChatSummary) ?? undefined,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

const baseCtx = {
	chatId: "c1",
	deliver: () => {},
	jobStore: stubJobStore,
	spawn: () => {},
};

// ─── registration (the factory gate) ────────────────────────────────────────

describe("prober graph tools — registration", () => {
	it("no graphStore in the context → the tools are absent (gate decided server-side)", () => {
		const { chatStore } = fakeStores([]);
		const tools = createProberTools({ ...baseCtx, chatStore });
		assert.equal("list_sessions" in tools, false);
		assert.equal("list_propositions" in tools, false);
	});

	it("graphStore present → list_sessions + list_propositions join the registry beside the usual set", () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		// The standing set plus the two graph-map readers.
		assert.deepEqual(Object.keys(tools).sort(), ["ask_user_question", "list_propositions", "list_sessions", "probe", "probe_done"]);
	});
});

// ─── output shape + the no-prose rule ──────────────────────────────────────

describe("list_sessions", () => {
	it("names, kinds, counts, dates, ids — in the prober's voice, no statements", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node("n1", "Water cycle", [pt("c1")]),
				node("n2", "Evaporation", [pt("c1")]),
				node("n3", "Nietzsche", [pt("c-file")]),
			],
			{
				chats: [
					{
						id: "c1",
						title: "First lesson",
						createdAt: "2026-09-20T10:00:00.000Z",
						updatedAt: "2026-09-21T10:00:00.000Z",
					},
				],
			},
		);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.match(out, /2 session\(s\) in the knowledge graph, most recent first:/);
		// The chat: name, kind, born count, dates, id — the full resume.
		assert.match(out, /First lesson \(chat, 2 propositions, born 2026-09-20T10:00:00.000Z, last active 2026-09-21T10:00:00.000Z\) — id: c1/);
		// The unrecorded birth session falls back honestly: the id, no fake date.
		assert.match(out, /c-file \(file, 1 proposition, born unknown date\) — id: c-file/);
		// The owner ruling: the map's prose never reaches the prober.
		assert.ok(!out.includes("statement of"));
	});

	it("an empty graph gets an honest answer, not an empty string or a throw", async () => {
		const { chatStore, graphStore } = fakeStores([]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.equal(out, "The knowledge graph is empty — no session has contributed propositions yet.");
	});
});
