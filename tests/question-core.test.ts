/** Unit tests — question-core (pure logic, no server, no LLM). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
	quizInputProblems,
	quizInputSchema,
	probeQuizInputSchema,
} from "../src/core/question-core.ts";

// ─── the authoring contract (TypeBox schemas + execute-time refinements) ── Schema-valid ⇔ gradeable
const boundaryOk = (schema: TSchema, input: unknown, problems: string[]): boolean =>
	Value.Check(schema, input) && problems.length === 0;

describe("the schema's argument order (reasoning before the pick)", () => {
	// Argument-order ruling: the explanation is reasoning, and reasoning happens BEFORE the answer is chosen — models emit tool args in schema order
	it("emits explanation immediately before correctAnswer (both agents' schemas)", () => {
		// The 2026-09-25 ruling stands for the CONTENT fields (reasoning before the pick); the 2026-10-09 reorder adds its mirror for the teach schema
		for (const schema of [quizInputSchema, probeQuizInputSchema]) {
			const keys = Object.keys((schema as { properties: Record<string, unknown> }).properties);
			assert.ok(
				keys.indexOf("explanation") < keys.indexOf("correctAnswer"),
				`explanation must precede correctAnswer in the emitted schema (got: ${keys.join(", ")})`,
			);
			assert.deepEqual(keys, schema === quizInputSchema
				? ["type", "nodeId", "question", "options", "multiSelect", "explanation", "correctAnswer", "details"]
				: ["question", "options", "multiSelect", "explanation", "correctAnswer", "details"]);
		}
	});
});

describe("quizInputSchema / quizInputProblems (the authoring contract)", () => {
	const valid = {
		question: "Which planet is closest to the Sun?",
		options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
		correctAnswer: "Mercury",
		explanation: "Mercury is the innermost planet.",
		type: "check",
		nodeId: "planet-order",
	};

	it("accepts a valid single-select quiz (label as correctAnswer)", () => {
		assert.equal(boundaryOk(quizInputSchema, valid, quizInputProblems(valid)), true);
		assert.deepEqual(quizInputProblems(valid), []);
	});

	it("accepts explicit values and multi-select arrays (incl. JSON-stringified)", () => {
		const multi = {
			...valid,
			options: [
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
				{ label: "C", value: "c" },
			],
			correctAnswer: ["a", "b"],
			multiSelect: true,
		};
		assert.equal(boundaryOk(quizInputSchema, multi, quizInputProblems(multi)), true);
		// The union lists String first, so providers sometimes stringify arrays.
		const stringified = { ...multi, correctAnswer: JSON.stringify(multi.correctAnswer) };
		assert.equal(boundaryOk(quizInputSchema, stringified, quizInputProblems(stringified)), true);
		assert.deepEqual(quizInputProblems(stringified), []);
	});

	it("rejects the observed failure: a correctAnswer slug matching no option value, listing the valid values", () => {
		// The exact class GLM produced live (Gate 3 + live verification).
		const bad = {
			question: "What is Nietzsche's genealogical claim about religion?",
			options: [
				{ label: "A cultural diagnosis" },
			{ label: "Atheism as a conclusion" },
			{ label: "A call to convert people" },
		],
			correctAnswer: "cultural-diagnosis",
			explanation: "...",
		};
		assert.equal(boundaryOk(quizInputSchema, bad, quizInputProblems(bad)), false);
		const problems = quizInputProblems(bad);
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /does not match any option value/);
		assert.match(problems[0]!, /"A cultural diagnosis"/); // the valid values are listed for the retry
	});

	it("rejects multiple correct answers without multiSelect (ungradeable single-select)", () => {
		const bad = { ...valid, correctAnswer: ["Venus", "Mercury"] };
		assert.equal(boundaryOk(quizInputSchema, bad, quizInputProblems(bad)), false);
		assert.match(quizInputProblems(bad).join(" "), /multiSelect/);
	});

	it("rejects duplicate option values", () => {
		const bad = {
			...valid,
			options: [
				{ label: "Mercury", value: "same" },
				{ label: "Venus", value: "same" },
			],
		};
		assert.equal(boundaryOk(quizInputSchema, bad, quizInputProblems(bad)), false);
		assert.match(quizInputProblems(bad).join(" "), /same value/);
	});

	it("rejects an empty option label", () => {
		const bad = { ...valid, options: [{ label: "  " }, { label: "Mercury" }, { label: "Mars" }] };
		assert.equal(boundaryOk(quizInputSchema, bad, quizInputProblems(bad)), false);
		assert.match(quizInputProblems(bad).join(" "), /label is empty/);
	});

	it("requires a resolvable correctAnswer", () => {
		assert.equal(boundaryOk(quizInputSchema, { ...valid, correctAnswer: "" }, quizInputProblems({ ...valid, correctAnswer: "" })), false);
		assert.equal(boundaryOk(quizInputSchema, { ...valid, correctAnswer: "[]" }, quizInputProblems({ ...valid, correctAnswer: "[]" })), false);
		assert.match(quizInputProblems({ ...valid, correctAnswer: "" }).join(" "), /required/);
	});
});

// ─── buildAnswer + formatAnswerMessage ──────────────────────────────────────

