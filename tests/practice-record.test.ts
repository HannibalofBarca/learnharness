/** PRACTICE RECORD MECHANICS: the native shapes beneath the two practice tools — the active-problem fold (conclude-before-next-problem) */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssistantMessage, ToolResultMessage } from "../src/core/agent-types.ts";
import {
	activeProblemOf,
	newThinkingMessage,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";

// ── builders (native-shaped test fixtures) ───────────────────────────────────

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

function problemPose(callId = "call_p1", statement = "Show that…"): LhMessage[] {
	const assistant: LhMessage & AssistantMessage = {
		id: `msg_a_${callId}`,
		role: "assistant",
		content: [
			{ type: "toolCall", id: callId, name: PRACTICE_PROBLEM_TOOL, arguments: { statement, mode: "recall", modelSolution: statement } },
		],
		timestamp: 1,
		...STAMPS,
	};
	const ack: LhMessage & ToolResultMessage = {
		id: `msg_r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: PRACTICE_PROBLEM_TOOL,
		content: [{ type: "text", text: "Problem posed — the turn ends here." }],
		details: null,
		isError: false,
		timestamp: 2,
	};
	return [assistant, ack];
}

function concludeCall(outcome: string): LhMessage[] {
	// Honest folds: the conclude call rides WITH its clean ack — a dangling or errored conclude never freed anything.
	return [
		{
			id: `msg_c_${outcome}`,
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: `call_conclude_${outcome}`,
					name: PRACTICE_CONCLUDE_TOOL,
					arguments: { outcome },
				},
			],
			timestamp: 3,
			...STAMPS,
		},
		{
			id: `msg_cr_${outcome}`,
			role: "toolResult",
			toolCallId: `call_conclude_${outcome}`,
			toolName: PRACTICE_CONCLUDE_TOOL,
			content: [{ type: "text", text: "Problem concluded — the composer is free; pose the next problem or wrap up." }],
			details: null,
			isError: false,
			timestamp: 4,
		},
	];
}

// ── the active-problem fold ──────────────────────────────────────────────────

describe("activeProblemOf (the conclude-before-next-problem gate's fold)", () => {
	it("no messages → nothing active", () => {
		assert.equal(activeProblemOf([]), null);
	});

	it("a posed problem (call + ack) is ACTIVE — the ack does not conclude", () => {
		const messages = problemPose();
		const active = activeProblemOf(messages);
		assert.equal(active?.toolCallId, "call_p1");
		assert.deepEqual(active?.input, { statement: "Show that…", mode: "recall", modelSolution: "Show that…" });
	});

	it("thinking submissions keep it active (nudges never conclude)", () => {
		const messages = [
			...problemPose(),
			newThinkingMessage("call_p1", "stuck at the second step"),
		];
		assert.equal(activeProblemOf(messages)?.toolCallId, "call_p1");
	});

	it("a conclude call deactivates", () => {
		const messages = [...problemPose(), ...concludeCall("solved")];
		assert.equal(activeProblemOf(messages), null);
	});

	it("an ERRORED pose never activates (the BKT phantom — honest activation)", () => {
		// The gate refused the pose ("a problem is already active" in the BKT incident); the composer must not mount from its arguments.
		const rejected = problemPose("call_bad", "A different student…");
		(rejected[1]! as unknown as { isError: boolean }).isError = true;
		assert.equal(activeProblemOf(rejected), null, "a lone refused pose is nothing");
	});
});
