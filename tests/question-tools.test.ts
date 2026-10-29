/** The agent-split question tools (docs/probe-teach-split.md §1): - teachQuizToolFor — the TEACHER's quiz */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	teachQuizToolFor,
} from "../src/agent/tools.ts";
import { quizInputObject } from "../src/core/question-core.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

const dataDir = path.join(PATHS.root, "data");
fs.mkdirSync(dataDir, { recursive: true });

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* scratch cleanup, best effort */
		}
	}
});

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

const validQuiz = {
	question: "What is 2 + 2?",
	options: [
		{ label: "3", value: "3" },
		{ label: "4", value: "4" },
	],
	correctAnswer: "4",
	explanation: "Arithmetic.",
	type: "check",
	nodeId: "arith",
};

import type { AgentToolResult } from "../src/core/agent-types.ts";

/** The Wave A boundary predicate: pi's loop structurally validates against the TypeBox parameters */
async function boundaryParse(
	// `input: never` param: contravariance lets any AgentTool's execute slot in.
	tool: { parameters: any; execute: (id: string, input: never) => Promise<unknown> },
	input: unknown,
): Promise<{ success: boolean; error?: AgentToolResult<{ tool: string; problems: string[] }> }> {
	if (!Value.Check(tool.parameters, input)) return { success: false };
	const result = (await tool.execute("tc", input as never)) as AgentToolResult<{
		tool: string;
		problems: string[];
	}>;
	if (result.isError) return { success: false, error: result };
	return { success: true };
}
const problemLines = (r?: AgentToolResult<{ tool: string; problems: string[] }>): string[] =>
	r?.details.problems ?? [];

describe("teachQuizToolFor: the dynamic plan-nodeId validation (position signal)", () => {
	it("accepts a nodeId that matches a node of the session's tree", async () => {
		const chatId = newChat("NodeId: valid");
		chatStore.saveTree(chatId, {
			nodes: [
				{ id: "arith", title: "Arithmetic" },
				{ id: "expressions", title: "Expressions" },
			],
			edges: [{ from: "arith", to: "expressions" }],
			version: 1,
		});
		const res = await boundaryParse(teachQuizToolFor({ chatId, chatStore }), {
			...validQuiz,
			nodeId: "expressions",
		});
		assert.equal(res.success, true);
	});

	it("rejects a nodeId that matches no node — with a message listing the slugs", async () => {
		const chatId = newChat("NodeId: typo");
		chatStore.saveTree(chatId, {
			nodes: [{ id: "arith", title: "Arithmetic" }],
			edges: [],
			version: 1,
		});
		const res = await boundaryParse(teachQuizToolFor({ chatId, chatStore }), {
			...validQuiz,
			nodeId: "arithmetic", // the typo — slug is 'arith'
		});
		assert.equal(res.success, false);
		const msg = problemLines(res.error).join("\n");
		assert.match(msg, /matches no node/);
		assert.match(msg, /arith/);
	});

	it("no tree yet: ANY nodeId is rejected — quizzes wait for plan_init", async () => {
		const chatId = newChat("NodeId: no tree");
		const tool = teachQuizToolFor({ chatId, chatStore });
		const res = await boundaryParse(tool, { ...validQuiz, nodeId: "anything" });
		assert.equal(res.success, false);
		assert.match(problemLines(res.error).at(-1)!, /No plan map exists yet — call plan_init/);
	});

	it("missing nodeId is rejected at the boundary (owner ruling 2026-09-26: no untagged quizzes)", async () => {
		const chatId = newChat("NodeId: required");
		chatStore.saveTree(chatId, {
			nodes: [{ id: "arith", title: "Arithmetic" }],
			edges: [],
			version: 1,
		});
		const tool = teachQuizToolFor({ chatId, chatStore });
		const { nodeId: _dropped, ...untagged } = validQuiz;
		const res = await boundaryParse(tool, untagged);
		assert.equal(res.success, false, "an untagged quiz must be rejected back to the model");
		// The structural pin: the SCHEMA itself names the missing field (pi's boundary formats Value.Errors as the tool-input-error the model sees).
		const schemaErrors = [...Value.Errors(quizInputObject, untagged)].map((e) => e.message);
		assert.match(
			schemaErrors.join("\n"),
			/nodeId/,
			"the schema rejection names nodeId so the model can retry tagged",
		);
	});
});
