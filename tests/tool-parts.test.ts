/** Unit tests — the UI parse seam (src/core/tool-parts.ts). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	parseQuizInput,
} from "../src/core/tool-parts.ts";
import { quizInputSchema, probeQuizInputSchema } from "../src/core/question-core.ts";

const TEACHER_QUIZ = {
	question: "What does Tarski's convention-T define?",
	options: [
		{ label: "Truth for a language", value: "truth" },
		{ label: "Provability", value: "provability" },
	],
	correctAnswer: "truth",
	explanation: "Convention-T schematizes truth for the object language.",
	type: "check", // teach-only role field — the display parse KEEPS it (the dock gates by it)
	nodeId: "convention-t", // teacher-only field — the display parse must accept and strip it
};

const PROBER_QUIZ = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};


describe("parseQuizInput", () => {
	it("parses a boundary-valid TEACHER quiz and strips the teacher-only nodeId", () => {
		const parsed = parseQuizInput(TEACHER_QUIZ);
		assert.ok(parsed);
		assert.equal(parsed.question, TEACHER_QUIZ.question);
		assert.equal((parsed as Record<string, unknown>).nodeId, undefined, "unknown keys are stripped, not trusted");
		assert.equal((parsed as { type?: unknown }).type, "check", "the role field survives the display parse (owner 2026-10-03)");
	});

	it("parses a boundary-valid PROBER quiz (no nodeId at all)", () => {
		assert.ok(parseQuizInput(PROBER_QUIZ));
	});

	it("boundary parity: anything the TEACH schema accepts, the display parse accepts", () => {
		assert.ok(Value.Check(quizInputSchema, TEACHER_QUIZ), "fixture must be boundary-valid for this pin to mean anything");
		assert.ok(parseQuizInput(TEACHER_QUIZ));
	});

	it("boundary parity: anything the PROBE schema accepts, the display parse accepts", () => {
		assert.ok(Value.Check(probeQuizInputSchema, PROBER_QUIZ));
		assert.ok(parseQuizInput(PROBER_QUIZ));
	});

	it("boundary parity: the 2026-09-26 string-options shape heals on read (universal-heal mirror, 2026-10-09)", () => {
		// The boundary now heals a JSON-encoded options string at EVERY registry, and the record keeps the RAW args
		const stringified = { ...PROBER_QUIZ, options: JSON.stringify(PROBER_QUIZ.options) };
		const parsed = parseQuizInput(stringified);
		assert.ok(parsed, "the healed-at-boundary record must parse on read");
		assert.deepEqual(parsed.options, PROBER_QUIZ.options);
	});
});
