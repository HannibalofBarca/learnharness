/** Graph merger + trigger + derivation tests. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import type { AuditVerdicts, SessionFindings } from "../src/core/contracts.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { getGraph, graphSnapshot, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import { graphStore } from "../src/store/graph.ts";
import { chatStore } from "../src/store/chats.ts";
import { LEDGER_FILES, PATHS, SOURCES_FILE } from "../config.ts";

/** The wired fs adapters, exactly what src/server/stores.ts passes in production. */
const graphDeps = { chatStore, graphStore } as const satisfies GraphDeps;

/** The session merge source for a chat — what the pipeline passes: the fold stamp only. */
function sessionSource(chatId: string): { foldedAt: string } {
	const record = chatStore.getChat(chatId)!;
	return { foldedAt: record.updatedAt };
}

// ─── ledger isolation (backup-and-clear of data/graph/*.jsonl) ──────────────

const LEDGER_PATHS = [...Object.values(LEDGER_FILES), SOURCES_FILE];
const backups: Array<{ file: string; bak: string }> = [];
const createdChats: string[] = [];

fs.mkdirSync(PATHS.graph, { recursive: true });
for (const file of LEDGER_PATHS) {
	if (fs.existsSync(file)) {
		const bak = `${file}.w5test.bak`;
		fs.renameSync(file, bak);
		backups.push({ file, bak });
	}
}

after(() => {
	for (const file of LEDGER_PATHS) {
		try {
			fs.unlinkSync(file);
		} catch {
			/* nothing was written here */
		}
	}
	for (const { file, bak } of backups) fs.renameSync(bak, file);
	for (const id of createdChats) {
		try {
			fs.unlinkSync(`${PATHS.chats}/${id}.json`);
		} catch {
			/* already gone */
		}
	}
});

// ─── fixture builders ──────────────────────────────────────────────────────── Native fixture builders: the record holds pi-native history
interface NativeCall {
	name: string;
	toolCallId: string;
	input: Record<string, unknown>;
	output: QuestionAnswerData;
}

function user(id: string, text: string): LhMessage[] {
	return [{ id, role: "user", content: text, timestamp: Date.now() } as never];
}

/** A teacher-prose message. */
function teacher(id: string, text: string): LhMessage[] {
	return [{ id, role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as never];
}

function assistant(id: string, calls: NativeCall[]): LhMessage[] {
	const content = calls.map((c) => ({ type: "toolCall", id: c.toolCallId, name: c.name, arguments: c.input as never }));
	const out: LhMessage[] = [
		{
			id,
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: Date.now(),
		} as never,
	];
	for (const c of calls) {
		out.push({
			id: `r_${c.toolCallId}`,
			role: "toolResult",
			toolCallId: c.toolCallId,
			toolName: c.name,
			content: [{ type: "text", text: "ok" }],
			details: c.output,
			isError: false,
			timestamp: Date.now(),
		} as never);
	}
	return out;
}

function quizPart(
	toolCallId: string,
	input: Record<string, unknown>,
	output: QuestionAnswerData,
): NativeCall {
	return { name: "quiz", toolCallId, input, output };
}

function askPart(
	toolCallId: string,
	input: Record<string, unknown>,
	output: QuestionAnswerData,
): NativeCall {
	return { name: "ask_user_question", toolCallId, input, output };
}

function answer(over: Partial<QuestionAnswerData>): QuestionAnswerData {
	return {
		kind: "quiz",
		questionText: "question text",
		dontKnow: false,
		answers: [],
		answeredAt: "2026-08-22T00:00:00.000Z",
		...over,
	};
}

/** Create a chat in the real store with messages; returns the record. */
function fixtureChat(title: string, messages: LhMessage[]) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, messages);
	return chatStore.getChat(chat.id)!;
}

/** The full fixture transcript: five graded quizzes + a dismissed one + an ask. */
function fixtureMessages(): LhMessage[] {
	return [
		user("u1", "teach me the fixture topic"),
		assistant("a1", [
			quizPart(
				"call-1",
				{ question: "Q1", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionText: "Q1 text", correct: false, answeredAt: "2026-08-22T01:00:00.000Z" }),
			),
		]),
		assistant("a2", [
			quizPart(
				"call-2",
				{ question: "Q2", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionText: "Q2 text", dontKnow: true, correct: false, answeredAt: "2026-08-22T01:01:00.000Z" }),
			),
		]),
		assistant("a3", [
			// input.nodeId "alpha" is deliberately present and IGNORED — attribution is the only quiz→node path in the tree-blind world.
			quizPart(
				"call-3",
				{ question: "Q3", nodeId: "alpha", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionText: "Q3 text", correct: true, thinking: "recalled the diagram", answeredAt: "2026-08-22T02:00:00.000Z" }),
			),
		]),
		assistant("a4", [
			quizPart(
				"call-4",
				{ question: "Q4", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionText: "Q4 text", correct: false, answeredAt: "2026-08-22T02:01:00.000Z" }),
			),
		]),
		assistant("a5", [
			quizPart(
				"call-5",
				{ question: "Q5", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionText: "Q5 text", dontKnow: true, correct: false, answeredAt: "2026-08-22T02:02:00.000Z" }),
			),
		]),
		assistant("a6", [
			// dismissed quiz + an answered ask — neither becomes an event
			quizPart(
				"call-6",
				{ question: "Q6", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionText: "Q6 text", dismissed: true }),
			),
			askPart(
				"call-7",
				{ question: "free text?" },
				answer({ kind: "ask", questionText: "free text?", text: "because" }),
			),
		]),
	].flat();
}

/** The extractor's findings for the fixture chat: three propositions, one follows edge (the graph starts empty — no links). */
function fixtureFindings(): SessionFindings {
	return {
		propositions: [
			{
				id: "p1",
				name: "Alpha",
				statement: "Alpha intuition",
				aliases: ["alpha feel"],
			},
			{
				id: "p2",
				name: "Beta rule",
				statement: "Beta rule",
				aliases: [],
			},
			{
				id: "p3",
				name: "Gamma",
				statement: "Gamma application",
				aliases: [],
			},
		],
		chains: [
			{
				premises: ["p1"],
				conclusion: "p2",
			},
		],
	};
}

/** The auditor's verdicts when nothing links: an empty verdict set is a valid full review. */
function fixtureVerdicts(): AuditVerdicts {
	return { links: [] };
}

/** The chat every merger test folds (shared, so ordering is intentional). */
const chat1 = fixtureChat("Graph fixture", fixtureMessages());


// ─── the merger ──────────────────────────────────────────────────────────────

/** Everything the graph holds for a set of chats (other processes' test emissions run concurrently against the same files — scope, never assume). */
function scopedGraph(chatIds: string[]) {
	const graph = getGraph(graphStore);
	return {
		nodes: graph.nodes.filter((n) => n.provenance.some((pt) => chatIds.includes(pt.chatId))),
		chains: graph.chains.filter((c) => c.provenance.some((pt) => chatIds.includes(pt.chatId))),
	};
}

describe("the merger (mergeFindings)", () => {
	it("creates nodes from the verdicts with chat-level provenance", () => {
		const stats = mergeFindings(chat1.id, fixtureFindings(), fixtureVerdicts(), graphDeps, sessionSource(chat1.id));
		assert.deepEqual(stats, { nodes: 3, chains: 1 });

		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		const idByStatement = new Map(graph.nodes.map((n) => [n.statement, n.id]));
		for (const node of graph.nodes) {
			assert.match(node.id, /^n_/);
			assert.ok(node.name.length > 0, "name is required");
			assert.equal("kind" in node, false, "no kind field");
			assert.ok(Array.isArray(node.provenance), "provenance attached");
		}
		// Provenance without an anchor stays CHAT-LEVEL: this caller submits no messageId, so the run's source key is the whole provenance point.
		const alpha = graph.nodes.find((n) => n.statement === "Alpha intuition")!;
		assert.deepEqual(alpha.provenance, [{ chatId: chat1.id, messageId: "" }]);

		// The stored chain, provenance attached.
		assert.equal(graph.chains.length, 1);
		const chain = graph.chains[0]!;
		assert.match(chain.id, /^arg_/, "store-minted argument id");
		assert.deepEqual(chain.premises, [idByStatement.get("Alpha intuition")]);
		assert.equal(chain.conclusion, idByStatement.get("Beta rule"));
		assert.deepEqual(chain.provenance, [{ chatId: chat1.id, messageId: "" }]);

	});

	it("messageId anchors (2026-10-13): creates AND link-appends stamp the passage id; chains stay chat-level", () => {
		// The session submit's anchor: a proposition may carry its passage's message id
		const chat = fixtureChat(
			"Anchor fixture",
			[
				...user("u1", "teach anchors"),
				...teacher("t1", "First anchored passage."),
				...teacher("t2", "Second anchored passage."),
			].flat(),
		);
		const first = mergeFindings(
			chat.id,
			{
				propositions: [{ id: "p1", name: "Anchored", statement: "Anchored statement", aliases: [], messageId: "t1" }],
				chains: [],
			},
			{ links: [] },
			graphDeps,
			sessionSource(chat.id),
		);
		assert.equal(first.nodes, 1);
		const created = scopedGraph([chat.id]).nodes.find((n) => n.statement === "Anchored statement")!;
		assert.deepEqual(created.provenance, [{ chatId: chat.id, messageId: "t1" }], "the created node anchors to its passage");

		// The re-encounter: link-appended, anchored to ITS passage — while the chain the same job asserts stays chat-level.
		const second = mergeFindings(
			chat.id,
			{
				propositions: [
					{ id: "q1", name: "Anchored again", statement: "Anchored statement, rephrased", aliases: [], messageId: "t2" },
					{ id: "q2", name: "Follows", statement: "Follows the anchored claim", aliases: [], messageId: "t2" },
				],
				chains: [{ premises: ["q1"], conclusion: "q2" }],
			},
			{ links: [{ id: "q1", linkTo: created.id }] },
			graphDeps,
			sessionSource(chat.id),
		);
		assert.equal(second.nodes, 1, "q1 linked (no create), q2 created");
		const linkLine = graphStore
			.readNodes()
			.filter((n) => n.id === created.id)
			.find((line) => line.provenance.some((pt) => pt.chatId === chat.id && pt.messageId === "t2"));
		assert.ok(linkLine, "the link-append line carries the re-encounter's passage id");
		assert.equal(linkLine!.name, "Anchored again", "the appended line is the re-encounter (reads merge it into aliases)");
		const chains = graphStore.readChains().filter((c) => c.provenance.some((pt) => pt.chatId === chat.id));
		assert.equal(chains.length, 1);
		assert.deepEqual(chains[0]!.provenance, [{ chatId: chat.id, messageId: "" }], "chains stay chat-level — never anchored");
	});

	it("merges INDEPENDENTLY per call — no cross-run identity (owner, 2026-09-29)", () => {
		// The mappings ledger is gone: resolution is a job-local in-memory map, so a second merge of the same verdicts knows nothing of the first.
		const rep = fixtureChat("Independence fixture", [user("u1", "rep")].flat());
		const findings: SessionFindings = {
			propositions: [
				{ id: "p1", name: "Rep one", statement: "Independence one statement", aliases: [] },
				{ id: "p2", name: "Rep two", statement: "Independence two statement", aliases: [] },
			],
			chains: [{ premises: ["p1"], conclusion: "p2" }],
		};
		const first = mergeFindings(rep.id, findings, { links: [] }, graphDeps, sessionSource(rep.id));
		assert.deepEqual(first, { nodes: 2, chains: 1 });
		const second = mergeFindings(rep.id, findings, { links: [] }, graphDeps, sessionSource(rep.id));
		assert.deepEqual(second, { nodes: 2, chains: 1 }, "nothing remembered — everything re-creates");
		const graph = scopedGraph([rep.id]);
		assert.equal(graph.nodes.length, 4, "the propositions merge again as fresh nodes");
		assert.equal(graph.chains.length, 2, "fresh endpoints — fresh chain assertions");
		// exactly one checkpoint line per merge, though — checkpoints are a log
		assert.equal(graphStore.readCheckpoints().filter((c) => c.chatId === rep.id).length, 2);
	});

	it("is idempotent WITHIN one submit — a repeated proposition id resolves once", () => {
		const dup = fixtureChat("Duplicate-id fixture", [user("u1", "dup")].flat());
		const findings: SessionFindings = {
			propositions: [
				{ id: "p1", name: "Dup", statement: "Dup statement", aliases: [] },
				{ id: "p1", name: "Dup", statement: "Dup statement", aliases: [] },
			],
			chains: [],
		};
		const stats = mergeFindings(dup.id, findings, { links: [] }, graphDeps, sessionSource(dup.id));
		assert.deepEqual(stats, { nodes: 1, chains: 0 }, "the duplicate id is skipped — first resolution stands");
	});

	it("applies a linkTo verdict: phrasings join aliases, provenance unions, no duplicate node", () => {
		const alphaId = scopedGraph([chat1.id]).nodes.find((n) => n.statement === "Alpha intuition")!.id;
		const chat2 = fixtureChat("Graph fixture 2", [
			user("u1", "again"),
			assistant("a1", [
				quizPart(
					"call-9",
					{ question: "Q9", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
					answer({ questionText: "Q9 text", correct: true, answeredAt: "2026-08-22T03:00:00.000Z" }),
				),
			]),
		].flat());

		// The auditor's identity verdict: this proposition IS the alpha node.
		const stats = mergeFindings(
			chat2.id,
			{
				propositions: [
					{
						id: "q1",
						name: "Alpha",
						statement: "Alpha feel", // a DIFFERENT phrasing — identity is the verdict, not strings
						aliases: ["alpha intuition"],
					},
				],
				chains: [],
			},
			// VERDICTS-ONLY: the identity call is a link entry, not a field on the proposition.
			{ links: [{ id: "q1", linkTo: alphaId }] },
			graphDeps,
			sessionSource(chat2.id),
		);
		assert.deepEqual(stats, { nodes: 0, chains: 0 });

		const after = scopedGraph([chat1.id, chat2.id]);
		assert.equal(after.nodes.length, 3, "no duplicate node");
		const alpha = getGraph(graphStore).nodes.find((n) => n.id === alphaId)!;
		assert.ok(alpha.aliases.includes("Alpha feel"), "the session's phrasing joins the aliases");
		assert.ok(alpha.aliases.includes("alpha intuition"));
		assert.ok(
			alpha.provenance.some((pt) => pt.chatId === chat2.id),
			"provenance unions",
		);
	});

	it("resolves imported-notes ids to their file paths in the snapshot (static provenance)", () => {
		// The notes front door in miniature: a source record + a merge under its src id — the snapshot must label it with the file path (a static entry)
		graphStore.upsertSource({ id: "src_snapfixture", filePath: "/vault/learn vim.md", importedAt: "2026-09-13T00:00:00.000Z" });
		mergeFindings(
			"src_snapfixture",
			{
				propositions: [
					{
						id: "p1",
						name: "Vim registers",
						statement: "Vim registers map single keys to editing commands.",
						aliases: [],
					},
				],
				chains: [],
			},
			{ links: [] },
			graphDeps,
			{ foldedAt: "2026-09-13T00:00:00.000Z" },
		);
		const snap = graphSnapshot(graphDeps);
		const node = snap.nodes.find((n) => n.statement === "Vim registers map single keys to editing commands.")!;
		assert.equal(snap.fileSources["src_snapfixture"], "/vault/learn vim.md");
		assert.deepEqual(snap.nodeSessions[node.id], ["src_snapfixture"], "the file entry joins the node's sessions list");
		assert.equal(snap.sessions["src_snapfixture"], undefined, "a notes source is never a chat session");
	});
});

// ─── session deletion ─────

