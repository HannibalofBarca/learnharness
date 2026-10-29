/** The UI parse seam — parse, don't cast. */

import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { quizDisplayInputSchema, askInputSchema, askOptionProblems, quizInputProblems, explainInputProblems, explainDisplayInputSchema, type AskToolInput, type QuizToolInput, type ExplainToolInput } from "./question-core.ts";
import { healEncodedArguments } from "./argument-heal.ts";
import { probeDoneInputSchema, type ProbeDoneInput } from "./contracts/probe.ts";

/** The pi-boundary parse step, mirrored here */
function boundaryParse<T>(schema: TSchema, input: unknown): T | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const converted = structuredClone(input);
	Value.Convert(schema, converted);
	if (!Value.Check(schema, converted)) return undefined;
	return Value.Clean(schema, converted) as T;
}

/** Quiz parse for DISPLAY: the shared authoring base, pre-refinement. */
/** Shape parsing never repairs authored text. */
export function parseQuizInput(input: unknown): QuizToolInput | undefined {
	// quizDisplayInputSchema: base + the OPTIONAL `type`
	const healedInput = healEncodedArguments(input, quizDisplayInputSchema);
	const cleaned = boundaryParse<QuizToolInput>(quizDisplayInputSchema, healedInput);
	if (!cleaned) return undefined;
	if (quizInputProblems(cleaned).length > 0) return undefined;
	return cleaned;
}

/** Ask parse for DISPLAY: the full ask schema (options optional — free-text mode is the options-less shape) */
export function parseAskInput(input: unknown): AskToolInput | undefined {
	const cleaned = boundaryParse<AskToolInput>(askInputSchema, input);
	if (!cleaned) return undefined;
	if (askOptionProblems(cleaned.options ?? []).length > 0) return undefined;
	return cleaned;
}

/** Explain parse for DISPLAY: the display schema (base + OPTIONAL lenient `type`, exactly the quiz pattern */
export function parseExplainInput(input: unknown): ExplainToolInput | undefined {
	const cleaned = boundaryParse<ExplainToolInput>(explainDisplayInputSchema, input);
	if (!cleaned) return undefined;
	if (explainInputProblems(cleaned).length > 0) return undefined;
	return cleaned;
}

/** probe_done parse — the core-owned schema the tool itself declares. */
export function parseProbeDoneInput(input: unknown): ProbeDoneInput | undefined {
	return boundaryParse<ProbeDoneInput>(probeDoneInputSchema, input);
}