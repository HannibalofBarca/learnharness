/** The shared session-markdown engine: ONE renderer for the extractor's source view and the future user-facing session export */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { messageMarkdown } from "../src/core/session-markdown.ts";

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: Date.now() } as never;
}

function teacher(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}

function result(
	id: string,
	toolCallId: string,
	toolName: string,
	details: unknown,
	isError = false,
): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details,
		isError,
		timestamp: Date.now(),
	} as never;
}


describe("messageMarkdown", () => {
	it("renders speaker blocks with the id anchor", () => {
		const md = messageMarkdown(user("u1", "teach me the chain rule"), "u1");
		assert.equal(md, "### Learner · u1\n\nteach me the chain rule");
		const md2 = messageMarkdown(teacher("a1", "The derivative measures change."), "a1");
		assert.equal(md2, "### Teacher · a1\n\nThe derivative measures change.");
	});

	it("anchors off — the same document without the ids (the user export)", () => {
		const md = messageMarkdown(user("u1", "hello"), "u1", false);
		assert.equal(md, "### Learner\n\nhello");
	});

	it("quiz blocks: question + outcome + the learner's note", () => {
		const md = messageMarkdown(
			result("r1", "q1", "quiz", { questionText: "What is a derivative?", correct: false, dontKnow: false, note: "mixed up signs" }),
			"r1",
		)!;
		assert.match(md, /^### Quiz · r1$/m);
		assert.match(md, /\*\*Q:\*\* What is a derivative\?/);
		assert.match(md, /The learner answered incorrectly\./);
		assert.match(md, /\*\(his thinking: mixed up signs\)\*/);
	});
});
