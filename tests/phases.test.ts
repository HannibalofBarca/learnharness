/** phases — the event-driven phase chain (docs/probe-teach-split.md §4). */
import assert from "node:assert";
import test from "node:test";
import type { LhViewMessage } from "../src/core/view.ts";
import { phaseAt3 } from "../src/core/phases.ts";

/** Text-only user message. */
function user(text: string): LhViewMessage {
	return { id: `u_${text}`, role: "user", parts: [{ type: "text", text }] };
}

/** An assistant message carrying a tool part in the given state. */
function assistantTool(
	name: string,
	state: "input-available" | "output-available" | "output-error",
	output?: unknown,
): LhViewMessage {
	return {
		id: `a_${name}_${state}_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		parts: [{ type: `tool-${name}`, state, ...(output !== undefined ? { output } : {}) } as never],
	};
}

/** A quiz call with its parsed input — `nodeId` present iff tagged. */
function assistantQuiz(input: Record<string, unknown> | undefined): LhViewMessage {
	return {
		id: `a_quiz_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		parts: [{ type: "tool-quiz", ...(input !== undefined ? { input } : {}) } as never],
	};
}

const DONE_ASSESSMENT = { assessment: { strands: [{ strand: "s", assessment: "a" }] } };
const PLAN_OK = { ok: true, tree: { nodes: [{ id: "n1", title: "N" }], edges: [] } };

test("phaseAt3: probe until a concluded probe_done; plan until the first nodeId-tagged quiz; teach after", () => {
	const probe = phaseAt3([user("teach me calculus"), assistantQuiz({ question: "q", correctAnswer: "a" })]);
	assert.equal(probe, "probe", "an UNTAGGED quiz alone never ends the probe (probe quizzes carry no nodeId)");

	const concluded = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
	]);
	assert.equal(concluded, "plan", "a concluded probe_done ends the probe (planning begins)");

	const presented = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		user("looks good, go"),
	]);
	assert.equal(presented, "plan", "plan_init + the learner's go-ahead TEXT present and sanction nothing");

	const teaching = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		user("looks good, go"),
		assistantQuiz({ question: "q", nodeId: "gravity-basics", correctAnswer: "a" }),
	]);
	assert.equal(teaching, "teach", "the first nodeId-tagged quiz CALL is where teaching begins");

	const failedPlan = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-error", { ok: false, error: "bad mermaid" }),
		assistantQuiz({ question: "q", nodeId: "n1", correctAnswer: "a" }),
	]);
	assert.equal(failedPlan, "teach", "a tagged quiz begins teaching even after a failed init attempt");
});

test("phaseAt3: the tag is the seam — natural text and untagged questions never start teaching", () => {
	const plainText = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		user("The plan is accepted — begin teaching."), // words alone
		assistantQuiz({ question: "ad-hoc check", correctAnswer: "a" }), // untagged
	]);
	assert.equal(plainText, "plan", "only a nodeId-tagged quiz flips the seam — text and ad-hoc checks never do");

	const taggedOutOfOrder = phaseAt3([
		user("teach me"),
		assistantQuiz({ question: "q", nodeId: "n1", correctAnswer: "a" }), // before probe_done
	]);
	assert.equal(taggedOutOfOrder, "probe", "the chain never skips");
});

test("phaseAt3: a mere probe_done CALL (input-available, not yet concluded) keeps the probe open", () => {
	const still = phaseAt3([user("teach me"), assistantTool("probe_done", "input-available")]);
	assert.equal(still, "probe");
});

// ─── the native fold (phaseAt3Lh over LhMessage[]) ──────────────────────────



