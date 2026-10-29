/** Render smoke tests — the lesson from the v2 bugs: protocol tests don't see rendering. */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionDock } from "../components/question-dock.tsx";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { ChatActionsContext } from "../components/chat.tsx";
import type { JobRecord } from "../src/core/contracts.ts";

const quizInput = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};




describe("question submission draft restoration", () => {
	const draft = {
		selection: { selected: new Set([0]), otherSelected: true, dontKnow: false },
		thinking: "preserved reasoning",
		other: "preserved custom answer",
		text: "preserved free-text answer",
		confidenceIndex: 4,
	};

	it("restores a quiz selection, thinking, and confidence when its form remounts", () => {
		const html = renderToStaticMarkup(<QuestionDock toolName="quiz" toolCallId="q1" input={quizInput} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={draft} />);
		assert.match(html, /role="radio" aria-checked="true" data-kbdrow="0"/);
		assert.ok(html.includes("preserved reasoning"));
		assert.ok(html.includes("90%"));
	});

	it("restores an ask's custom answer and a free-text answer", () => {
		const custom = renderToStaticMarkup(<QuestionDock toolName="ask_user_question" toolCallId="ask1" input={{ question: "Fixture?", options: [{ label: "Listed answer" }, { label: "Another answer" }], multiSelect: true }} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={draft} />);
		assert.ok(custom.includes('value="preserved custom answer"'));
		assert.match(custom, /aria-checked="true" data-testid="other-option"/);
		const text = renderToStaticMarkup(<QuestionDock toolName="ask_user_question" toolCallId="ask2" input={{ question: "Fixture?" }} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={draft} />);
		assert.ok(text.includes("preserved free-text answer"));
	});
});

describe("DispatchCard — the BYOK refusal tone (owner, 2026-09-22)", () => {
	const job = (over: Partial<JobRecord>): JobRecord => ({
		id: "j1",
		kind: "research",
		chatId: "c1",
		toolCallId: "t1",
		status: "error",
		activity: "",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	});
	const inJobs = (jobs: JobRecord[]) => (
		<JobsContext.Provider value={jobs}>
			<ChatActionsContext.Provider
				value={{ chatId: "c1", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} }}
			>
				<DispatchCard toolCallId="t1" kind="research" />
			</ChatActionsContext.Provider>
		</JobsContext.Provider>
	);

	it("a models-refused job is INFO: quiet card, 'needs model setup', deep-link to the dialog", () => {
		const html = renderToStaticMarkup(
			inJobs([job({ error: "No model configured — set up your models first (missing: cheap)" })]),
		);
		assert.ok(html.includes('data-testid="dispatch-refused"'));
		assert.ok(html.includes("needs model setup"));
		assert.ok(html.includes('data-testid="dispatch-setup-link"'));
		assert.ok(html.includes("Set up models"));
		assert.ok(!html.includes("failed"));
		assert.ok(!html.includes("text-red-500"));
	});

	it("a key-refused job is INFO: 'needs a provider key', 'Add a key' (zero-keys wave, 66dbea9)", () => {
		const html = renderToStaticMarkup(
			inJobs([job({ error: "No OpenRouter key is set — add one in Settings → Keys" })]),
		);
		assert.ok(html.includes('data-testid="dispatch-refused"'));
		assert.ok(html.includes("needs a provider key"));
		assert.ok(html.includes("Add a key"));
		assert.ok(html.includes('data-testid="dispatch-setup-link"'));
		assert.ok(!html.includes("failed"));
	});
});
