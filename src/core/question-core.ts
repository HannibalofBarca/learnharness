/** question-core — the question contract + pure grading logic. */

import { Type, type Static } from "typebox";
import { stripModelValueDebris } from "./value-debris.ts";

// ─── shared types ───────────────────────────────────────────────────────────

export interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

// ─── tool input schemas (the question contract) ───────────────────────────── Parameter names mirror the prompt docs exactly — keep them in sync.

/** One quiz answer option. */
const quizOptionProps = {
	label: Type.String({ description: "Display label for the answer option — a bare claim, no reasoning" }),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
};

/** One ask answer option — keeps `description`: ask is ungraded preference collection, there is no correctness to leak. */
const askOptionProps = {
	...quizOptionProps,
	description: Type.Optional(
		Type.String({ description: "Optional extra detail shown below the option" }),
	),
};

/** GLM wobble guard: models sometimes emit `options` as a JSON-ENCODED STRING instead of an array. */
export function parseOptionsIfString<T>(options: string | T[] | undefined): unknown {
	if (typeof options !== "string") return options;
	try {
		const parsed: unknown = JSON.parse(options);
		if (Array.isArray(parsed)) return parsed;
	} catch {
		/* not JSON — fall through untouched */
	}
	return options;
}

// ─── cross-field authoring validation (tool-schema refinements) ────────── Enforced at the tool-call boundary (see the superRefines below)

/** Option sanity shared by quiz + ask: labels non-empty, resolved values (trimmed `value`, falling back to the trimmed label */
function optionProblems(
	options: Array<{ label: string; value?: string }>,
): { problems: string[]; keys: string[] } {
	const problems: string[] = [];
	const keys: string[] = [];
	options.forEach((option, i) => {
		const label = option.label.trim();
		if (label.length === 0) {
			problems.push(`options[${i}].label is empty — every option needs a label.`);
			return;
		}
		const key = option.value?.trim() || label;
		if (keys.includes(key)) {
			problems.push(`Two options resolve to the same value "${key}" — options must be distinct.`);
		}
		keys.push(key);
	});
	return { problems, keys };
}

/** ask options: the shared sanity, nothing more (ask is not graded). */
export function askOptionProblems(options: Array<{ label: string; value?: string }>): string[] {
	return optionProblems(options).problems;
}

/** The full quiz authoring contract: option sanity + correctAnswer must be gradeable. */
export function quizInputProblems(input: {
	options: Array<{ label: string; value?: string }>;
	correctAnswer: string | string[];
	multiSelect?: boolean;
}): string[] {
	const { problems, keys } = optionProblems(input.options);

	// Preserve exact option keys before trying copy-syntax cleanup — the same option-aware coercion runs at the display and grading seams.
	const entries = coerceCorrectAnswer(input.correctAnswer, keys);
	const unique = [...new Set(entries)];
	if (unique.length === 0 || unique.some((v) => v.length === 0)) {
		problems.push("correctAnswer is required — provide the value (or label) of the correct option(s).");
		return problems;
	}
	for (const v of unique) {
		if (!keys.includes(v)) {
			problems.push(
				`correctAnswer "${v}" does not match any option value. Valid values: ${keys.map((k) => `"${k}"`).join(", ")}. ` +
					"Copy the exact value (or label) of the intended option — never a paraphrase or slug.",
			);
		}
	}
	if (unique.length > 1 && input.multiSelect !== true) {
		problems.push(
				`correctAnswer lists ${unique.length} values but multiSelect is not true — a single-select question with several ` +
					"correct answers can never be answered correctly. Set multiSelect: true, or make exactly one option correct.",
		);
	}
	return problems;
}

// The SHARED quiz authoring fields — everything except `nodeId`.
const quizInputBase = Type.Object({
	question: Type.String({
		description:
			"The single quiz question to ask. ONE question per turn: ask, then end your turn — the answer determines the next question.",
	}),
	options: Type.Array(Type.Object(quizOptionProps), {
		minItems: 2,
		description:
			"REQUIRED. The answer options (2 or more) as a JSON ARRAY of option objects — never a " +
			"JSON-encoded string. Options only — there is no free-text mode. " +
			"Give each option a stable `value`; you reference the correct one by that value in correctAnswer. " +
			"Never add your own 'I don't know' option — that choice is added for you.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true when more than one option is correct and the learner must select all of them.",
		}),
	),
	explanation: Type.String({
		description:
			"REQUIRED. Explanation revealed AFTER the learner answers (shown whether they got it right or wrong). " +
			"Use it to reinforce why the correct answer is correct. It is written BEFORE correctAnswer by design: " +
			"reason it out first, then commit the answer the reasoning supports.",
	}),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			"REQUIRED. The correct answer as the option value(s) — the `value` field of the option you intend. " +
			'Single-select: a single string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]); ' +
			"the learner is only correct if their selection matches this set exactly. " +
			"Always pass the value, not a position number — this is self-checking and prevents miscounting. " +
			"A value that matches no option fails validation and the call is returned to you to fix.",
	}),
	details: Type.Optional(
		Type.String({ description: "Optional extra context or instructions shown under the question." }),
	),
});

// The TEACH-side quiz object: the shared base + the plan-position field + the ROLE field: `type` declares the question's role in the cycle.
const QUIZ_QUESTION_TYPES = ["predict", "check"] as const;
export type QuizQuestionType = (typeof QUIZ_QUESTION_TYPES)[number];

/** Normalize a persisted quiz `type` (display seam): old records carry none, and unhealable wobble degrades to undefined */
export function normalizeQuizType(raw: unknown): QuizQuestionType | undefined {
	if (typeof raw !== "string") return undefined;
	const v = stripModelValueDebris(raw);
	return v === "predict" ? "predict" : v === "check" ? "check" : undefined;
}

/** The reveal law as a pure predicate: a teach-phase CHECK collapses behind the "Check your understanding" reveal */
export function questionNeedsReveal(tool: string, rawInput: unknown, phase: string): boolean {
	if ((tool !== "quiz" && tool !== "explain") || phase !== "teach") return false;
	return normalizeQuizType((rawInput as { type?: unknown } | null)?.type) !== "predict";
}

/** The teaching-cycle role field, shared VERBATIM by both teach quizzing tools. */
const predictCheckType = Type.Union([Type.Literal("predict"), Type.Literal("check")], {
	description:
		"REQUIRED — the question's role in the teaching cycle, as a bare word (no quotes): predict = posed BEFORE " +
		"you teach the step (its own turn; the learner answers, then your teaching resolves it — arrives open, never " +
		"collapsed); check = posed AFTER the step's teaching is complete (arrives collapsed behind the Check your " +
		"understanding reveal). ONE question per turn either way.",
});


/** The TEACH-side quiz object. */
export const quizInputObject = Type.Object({
	type: predictCheckType,
	nodeId: Type.String({
		description:
			"REQUIRED plan-tree node id this question is about — must EXACTLY match one of this session's " +
			"plan_init node slugs (validated at call time; a mismatched id is rejected back to you). " +
			"The lesson's position on the map derives from these tags (the node the latest tagged question is about is " +
			"where the map stands; earlier ones count as visited). A node takes as many questions as it deserves: stay on " +
			"one node for as many turns as the understanding needs — one reasoning step at a time, never rush forward. " +
			"For off-map checks use ask_user_question.",
	}),
	...quizInputBase.properties,
});

/** The PROBE-side quiz declaration: the shared authoring contract, no nodeId and no `type` field at all — the session's map doesn't exist yet */
export const probeQuizInputSchema = quizInputBase;

/** The DISPLAY parse for persisted quiz calls (tool-parts.ts): the base + `type` as an OPTIONAL plain string (old records carry none */
export const quizDisplayInputSchema = Type.Object({
	...quizInputBase.properties,
	type: Type.Optional(Type.String()),
});

// ─── the explain tool ───────────── Quiz mechanics WITHOUT options: the learner answers in his own words.

export const explainInputBase = Type.Object({
	question: Type.String({
		description:
			"The single question to ask. ONE question per turn: ask, then end your turn — the answer determines the next.",
	}),
	correctAnswer: Type.String({
		description:
			"REQUIRED. The full correct answer in your own words, reasoning included — COMMITTED before the learner " +
			"ever sees the question. The commitment is immutable: when his answer returns, grade it strictly against this " +
			"text — never revise the commitment after seeing his words, and never mark a wrong answer right to be kind. " +
			"It is shown to him on submit; your next reply grades the nuance of what he wrote.",
	}),
	details: Type.Optional(
		Type.String({ description: "Optional extra context or instructions shown under the question." }),
	),
});

/** The TEACH-side explain object: base + the plan-position field (same semantics as the quiz's nodeId — the seam recognizes BOTH tools). */
/** The TEACH-side explain object: base + the teaching-cycle role field and the plan-position field (same semantics as the quiz's */
export const explainInputObject = Type.Object({
	type: predictCheckType,
	nodeId: Type.String({
		description:
			"REQUIRED plan-tree node id this question is about — must EXACTLY match one of this session's " +
			"plan_init node slugs (validated at call time; a mismatched id is rejected back to you). " +
			"The lesson's position on the map derives from these tags (the node the latest tagged question is about is " +
			"where the map stands; earlier ones count as visited). A node takes as many questions as it deserves: stay on " +
			"one node for as many turns as the understanding needs — one reasoning step at a time, never rush forward. " +
			"For off-map checks use ask_user_question.",
	}),
	...explainInputBase.properties,
});

/** The DISPLAY parse for persisted explain calls (tool-parts.ts): the base + `type` as an OPTIONAL plain string — exactly the quiz display pattern. */
export const explainDisplayInputSchema = Type.Object({
	...explainInputBase.properties,
	type: Type.Optional(Type.String()),
});

/** The explain authoring contract: the commitment must exist. */
export function explainInputProblems(input: { correctAnswer: string }): string[] {
	if (input.correctAnswer.trim().length === 0) {
		return ["correctAnswer is required — commit to the full correct answer BEFORE posing the question."];
	}
	return [];
}


/** The TEACHER's quiz declaration (base + the position field). */
export const quizInputSchema = quizInputObject;

export const askInputSchema = Type.Object({
	// No `mode` param — the pi original has none: the mode is inferred from whether options are present (the dock does exactly this).
	question: Type.String({
		description:
			"The single question to ask the learner. ONE question per turn: ask, then end your turn — the answer determines the next question.",
	}),
	details: Type.Optional(
		Type.String({ description: "Optional extra context or instructions shown under the question." }),
	),
	options: Type.Optional(
		Type.Array(Type.Object(askOptionProps), {
			minItems: 2,
			description:
				"Optional multiple-choice options. Omit for free-form text input. " +
				"The learner can always choose 'Other' and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set to true to allow multiple answers to the same question." }),
	),
});
// Ask's option sanity (labels non-empty, values distinct — ask is not graded

export type QuizToolInput = Static<typeof quizInputObject>;
export type AskToolInput = Static<typeof askInputSchema>;
export type ExplainToolInput = Static<typeof explainInputObject>;


/** A real selected answer, in the order the options were displayed. */
export interface OptionAnswer {
	label: string;
	value: string;
	index: number; // 1-based display index
}

export type QuestionKind = "quiz" | "ask" | "explain";
export type SelectMode = "single-select" | "multi-select";
export type QuestionMode = SelectMode | "text";

/** Full question data — stored in the `lh_question` custom entry. */
export interface QuestionData {
	id: string;
	kind: QuestionKind;
	/** quiz only: the question's role in the cycle — predict (before the teaching, never collapsed) or check (after it, behind the reveal). */
	questionType?: QuizQuestionType;
	question: string;
	context?: string;
	mode: QuestionMode;
	options: QuizOption[]; // display order (post-shuffle)
	// quiz only. NEVER send to the client before answering:
	correctIndices?: number[];
	// explain only. NEVER send to the client before answering:
	committedAnswer?: string;
	// quiz only (the MC "why"). NEVER send to the client before answering:
	explanation?: string;
	createdAt: string;
}

/** The learner's answer — full structured record, stored in `lh_question_answered`. */
export interface QuestionAnswerData {
	kind: QuestionKind;
	/** The persisted call's tool NAME: probe-phase calls are `probe`/`recall`, teach calls `quiz`/`explain` — the cards label by it ("Probe"/"Recall") */
	tool?: string;
	/** quiz only (teach phase): the role snapshot for rendering (a prediction tucks its explanation) and later calibration splits. */
	questionType?: QuizQuestionType;
	questionText: string;
	options?: { index: number; label: string }[]; // snapshot for rendering
	dontKnow: boolean;
	answers: OptionAnswer[];
	other?: string; // ask: "Other" free text
	text?: string; // ask/explain: text-mode answer
	/** The learner's reasoning on the QUESTION. */
	thinking?: string;
	/** @deprecated the pre-rename key — never written again; old records replay through the same types, so it stays declared. */
	note?: string;
	/** The learner's thinking WHILE READING the teaching prose — a separate channel from `thinking` */
	readingThinking?: string;
	confidence?: number; // quiz only: the learner's stated probability (0-100, raw) that his selected answer is correct — never sent on "I don't know"
	correct?: boolean; // quiz only
	correctIndices?: number[]; // quiz only (rendering)
	committed?: string; // explain only (rendering): the model's committed answer
	explanation?: string; // quiz only (rendering)
	dismissed?: boolean;
	answeredAt: string;
}


/** What the server passes to the bridge when the learner answers. */
export interface AnswerRequest {
	dontKnow?: boolean;
	values?: string[]; // option values
	other?: string; // ask "Other"
	text?: string; // ask text-mode
	thinking?: string; // the reasoning-on-the-question channel (was `note`)
	readingThinking?: string; // the thinking-while-reading channel (check answers)
	confidence?: number; // quiz only: 0-100 raw probability — 50 is a real coin flip, always sent
}

/** The confidence slider's snap stops: raw probability that the selected answer is correct, uneven on purpose */
export const CONFIDENCE_STOPS: readonly number[] = [0, 30, 50, 70, 90, 100];
export const DEFAULT_CONFIDENCE_INDEX = 2;

// ─── dock selection (the client state machine, pure for tests) ─────────────

/** The question dock's selection state (0-based indices in display order). */
export interface DockSelection {
	selected: Set<number>;
	otherSelected: boolean;
	dontKnow: boolean;
}

export const emptyDockSelection = (): DockSelection => ({ selected: new Set(), otherSelected: false, dontKnow: false });

/** In-memory submission snapshot: survives the question form's optimistic unmount, never written to storage. */
export interface QuestionFormDraft {
	selection: DockSelection;
	thinking: string;
	other: string;
	text: string;
	confidenceIndex: number;
}

export interface QuestionDraft {
	form?: QuestionFormDraft;
	readingThinking?: string;
}

/** Toggling a listed option. */
export function toggleOption(mode: SelectMode, sel: DockSelection, idx: number): DockSelection {
	if (mode === "multi-select") {
		const selected = new Set(sel.selected);
		if (selected.has(idx)) selected.delete(idx);
		else selected.add(idx);
		return { selected, otherSelected: sel.otherSelected, dontKnow: false };
	}
	return { selected: new Set([idx]), otherSelected: false, dontKnow: false };
}

/** Toggling the ask "Other…" row. */
export function toggleOther(mode: SelectMode, sel: DockSelection): DockSelection {
	if (mode === "multi-select") return { ...sel, otherSelected: !sel.otherSelected, dontKnow: false };
	return { selected: new Set(), otherSelected: true, dontKnow: false };
}

// ─── options ────────────────────────────────────────────────────────────────

export function normalizeOptions(
	options: string | Array<{ label: string; value?: string; description?: string }> | undefined,
): QuizOption[] {
	const seen = new Set<string>();
	// The persisted tool call can carry GLM's string-encoded options
	const coerced = parseOptionsIfString(options);
	const list = Array.isArray(coerced)
		? (coerced as Array<{ label: string; value?: string; description?: string }>)
		: [];
	return list
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => {
			if (option.label.length === 0) return false;
			if (seen.has(option.value)) throw new Error(`duplicate option value "${option.value}"`);
			seen.add(option.value);
			return true;
		});
}

/** Fisher-Yates over a copy. */
// ─── options ────────────────────────────────────────────────────────────────

/** mulberry32 seeded by a string — deterministic shuffle for hydration-safe rendering. */
export function seededRandom(seed: string): () => number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	let a = h >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher–Yates with an injectable RNG. */
export function shuffleOptions(options: QuizOption[], rand: () => number = Math.random): QuizOption[] {
	const out = [...options];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		const a = out[i]!;
		const b = out[j]!;
		out[i] = b;
		out[j] = a;
	}
	return out;
}

// ─── quiz grading ───────────────────────────────────────────────────────────

/** Preserve an exact option key before trying copy-syntax cleanup: a label's final period, quotes, or backticks can be CONTENT, not model debris. */
function coerceCorrectAnswer(
	correctAnswer: string | string[],
	optionValues: readonly string[],
): string[] {
	const clean = (value: string): string => {
		const trimmed = value.trim();
		return optionValues.includes(trimmed) ? trimmed : stripModelValueDebris(value);
	};
	if (Array.isArray(correctAnswer)) return correctAnswer.map(clean);
	const trimmed = correctAnswer.trim();
	// An exact string key can itself look like a JSON array.
	if (optionValues.includes(trimmed)) return [trimmed];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map((v) => clean(String(v)));
		} catch {
			// not valid JSON — treat as a single literal value
		}
	}
	return [clean(correctAnswer)];
}

/** Resolve author-supplied value(s) to 1-based display indices. */
export function resolveCorrect(
	correctAnswer: string | string[] | undefined,
	options: QuizOption[],
): { indices: number[]; error?: string } {
	if (correctAnswer === undefined) return { indices: [], error: "correctAnswer is required" };
	const arr = coerceCorrectAnswer(correctAnswer, options.map((o) => o.value));
	if (arr.length === 0) return { indices: [], error: "correctAnswer is required" };
	const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
	const indices: number[] = [];
	for (const raw of arr) {
		const v = typeof raw === "string" ? raw.trim() : raw;
		const idx = byValue.get(v);
		if (idx === undefined) {
			const known = options.map((o) => `"${o.value}"`).join(", ");
			return { indices: [], error: `correctAnswer "${v}" does not match any option value (${known})` };
		}
		indices.push(idx);
	}
	return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) };
}

/** Exact-set match: same number of selections, same indices. */
function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean {
	if (selectedIndices.length !== correctIndices.length) return false;
	const a = [...selectedIndices].sort((x, y) => x - y);
	const b = [...correctIndices].sort((x, y) => x - y);
	return a.every((v, i) => v === b[i]);
}

// ─── arming + answering ─────────────────────────────────────────────────────



/** Turn an AnswerRequest into the full answer record + the user message the agent will see. */
export function buildAnswer(qd: QuestionData, req: AnswerRequest, tool?: string): QuestionAnswerData {
	const base: QuestionAnswerData = {
		kind: qd.kind,
		...(tool ? { tool } : {}),
		questionType: qd.questionType,
		questionText: qd.question,
		options: qd.options.map((o, i) => ({ index: i + 1, label: o.label })),
		dontKnow: req.dontKnow === true,
		answers: [],
		thinking: req.thinking?.trim() || undefined,
		readingThinking: req.readingThinking?.trim() || undefined,
		answeredAt: new Date().toISOString(),
	};
	// resolve selected option values → OptionAnswer (in display order)
	if (req.values && req.values.length > 0) {
		const byValue = new Map(qd.options.map((o, i) => [o.value, { ...o, index: i + 1 }]));
		for (const v of req.values) {
			const opt = byValue.get(v);
			if (!opt) continue; // unknown value — ignore
			base.answers.push({ label: opt.label, value: opt.value, index: opt.index });
		}
		base.answers.sort((a, b) => a.index - b.index);
	}
	if (req.other?.trim()) base.other = req.other.trim();
	if (req.text?.trim()) base.text = req.text.trim();

	if (qd.kind === "quiz") {
		base.correctIndices = qd.correctIndices ?? [];
		base.explanation = qd.explanation;
		base.correct = base.dontKnow ? false : isCorrect(base.answers.map((a) => a.index), qd.correctIndices ?? []);
		// The confidence slider rides on real quiz answers only — never on "I don't know" (no answer, no probability).
		if (!base.dontKnow && req.confidence !== undefined) {
			base.confidence = Math.max(0, Math.min(100, Math.round(req.confidence)));
		}
	}
	if (qd.kind === "explain") {
		// No client grading — the model grades in its reply, against the commitment.
		base.committed = qd.committedAnswer;
	}
	return base;
}

/** The MODEL-VISIBLE answer record: the tool call already carries everything the model itself authored — the question, every option, the correct answer */
/** The dismissal record: the minimum honest answer. */
export function dismissedAnswer(kind: QuestionKind, questionText: string): QuestionAnswerData {
	return {
		kind,
		questionText,
		dontKnow: false,
		answers: [],
		dismissed: true,
		answeredAt: new Date().toISOString(),
	};
}

export function compactAnswerForModel(ad: QuestionAnswerData): Record<string, unknown> {
	if (ad.dismissed) return { kind: ad.kind, dismissed: true };
	const out: Record<string, unknown> = { kind: ad.kind };
	if (ad.dontKnow) out.dontKnow = true;
	// Array.isArray: the seam is called with `unknown` answers (test fixtures, foreign records) — degrade to omission, never crash.
	if (Array.isArray(ad.answers) && ad.answers.length > 0)
		out.answers = ad.answers.map((a) => ({ index: a.index, label: a.label }));
	if (ad.text) out.text = ad.text;
	if (ad.other) out.other = ad.other;
	// The verdict + stated confidence are the learner's PERFORMANCE — new information the model needs for its next move.
	if (ad.correct !== undefined && !ad.dontKnow) out.correct = ad.correct;
	if (ad.confidence !== undefined) out.confidence = ad.confidence;
	// Two DISTINCT thinking channels, clearly keyed so the model never conflates them: reasoning on the question vs thinking while reading the teaching.
	const thinking = ad.thinking ?? ad.note;
	if (thinking) out.thinking = thinking;
	if (ad.readingThinking) out.thinkingWhileReading = ad.readingThinking;
	return out;
}
