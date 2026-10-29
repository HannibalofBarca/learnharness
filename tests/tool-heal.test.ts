/** THE WHITEHEAD INCIDENT PINS: glm-5.3 (z-ai via OpenRouter) emitted two argument-wobble shapes in one real session — quiz `type */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "../src/agent/validate.ts";
import { healEncodedArguments } from "../src/core/argument-heal.ts";
import {
	quizInputObject,
} from "../src/core/question-core.ts";
import { createTeacherTools } from "../src/agent/tools.ts";

/** The teach registry's question tools (heals run in prepareArguments — no record is read until execute). */
const bareQuestionTools = () => createTeacherTools({ chatId: "heal-test", chatStore: {} as never });

/** The incident's exact encoding: the value wrapped in literal quotes. */
function QUOTED(value: string): string {
	return `"${value}"`;
}

// A complete, well-formed teach-quiz input — the incident's call with every field valid BUT the wobbled one.
function whiteheadQuiz(type: unknown, correctAnswer: unknown) {
	return {
		question: "What was Parmenides' claim?",
		options: [
			{ label: "Being is changeless and complete", value: "parmenides" },
			{ label: "Becoming is fundamental", value: "heraclitus" },
			{ label: "Split world", value: "split" },
			{ label: "Both unreal", value: "both-illusion" },
		],
		explanation: "What truly *is* cannot come to be or pass away — the flux is appearance.",
		correctAnswer,
		type,
		nodeId: "experience-first",
	};
}

describe("the death-loop shape — quiz type with quotes baked in", () => {
	it("heals the quote-encoded literal (the ten-retry loop)", () => {
		const healed = healEncodedArguments({ type: QUOTED("predict") }, quizInputObject) as {
			type: unknown;
		};
		assert.equal(healed.type, "predict");
	});

	it("END-TO-END: the healed args pass pi-ai validation where the raw threw", () => {
		const raw = whiteheadQuiz(QUOTED("predict"), ["parmenides"]);
		assert.throws(() => {
			validateToolArguments({ name: "quiz", parameters: quizInputObject } as never, {
				id: "call_x",
				type: "toolCall",
				name: "quiz",
				arguments: raw,
			} as never);
		});
		const validated = validateToolArguments(
			{ name: "quiz", parameters: quizInputObject } as never,
			{
				id: "call_x",
				type: "toolCall",
				name: "quiz",
				arguments: healEncodedArguments(raw, quizInputObject),
			} as never,
		);
		assert.equal((validated as { type: unknown }).type, "predict");
	});

	it("WIRING: bareQuestionTools (the registry with NO prepareArguments) now heals", () => {
		const tools = bareQuestionTools();
		const quiz = tools.quiz;
		assert.ok(quiz, "the bare quiz must exist");
		assert.ok(quiz.prepareArguments, "the bare quiz must carry the standard heal");
		const healed = quiz.prepareArguments!(
			whiteheadQuiz(QUOTED("predict"), ["parmenides"]),
		) as { type: unknown };
		assert.equal(healed.type, "predict");
	});
});
