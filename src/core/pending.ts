/** Wave D: these scans read VIEW messages (core/view.ts LhViewMessage — the client's grouped transcript). */
interface UIMessage {
	role?: string;
	parts: Array<Record<string, unknown> & { type: string }>;
}

function isToolUIPart(part: UIMessage["parts"][number]): boolean {
	return part.type.startsWith("tool-") && typeof part.toolCallId === "string";
}

/** The pending-question gate: an unanswered QUESTION tool part (quiz/ask) blocks the composer — one question at a time */
interface PendingToolCall {
	toolCallId: string;
	tool: string;
	/** Tool input (quiz/ask args) — lets the composer pick note vs answer mode. */
	input: unknown;
}

/** Tools that render in the question dock and gate the composer. */
export const QUESTION_TOOLS = [
	"quiz",
	"probe",
	"ask_user_question",
	"explain",
	"recall",
] as const;

/** The tool→kind map (the dock's own fold, named once — the dismissal path and the dock must never disagree on what a tool is). */
export function toolQuestionKind(tool: string): "quiz" | "ask" | "explain" {
	return tool === "quiz" || tool === "probe" ? "quiz" : tool === "explain" || tool === "recall" ? "explain" : "ask";
}


// ─── Tool availability ─────────────────────────────

/** The tools a user may toggle off in settings — THE DEFINITIVE LIST. */
const TOGGLEABLE_TOOLS = ["research", "demo", "visual", "pdf"] as const;

/** The keys the settings WRITE side accepts in agent.tools: the plain toggleables PLUS the quizzing-mechanics switch. */
export const WRITABLE_TOOL_KEYS = [...TOGGLEABLE_TOOLS, "explain"] as const;

/** The resolved settings → factory seam shape (Platform wires chat-handler to pass this through from the settings record */
export type EnabledTools = Partial<Record<string, boolean>>;

/** Drop every tool the resolved settings mark as disabled. */
export function filterEnabledTools<T>(tools: Record<string, T>, enabled?: EnabledTools): Record<string, T> {
	if (!enabled) return tools;
	const out: Record<string, T> = {};
	for (const [name, tool] of Object.entries(tools)) {
		if (enabled[name] === false) continue;
		out[name] = tool;
	}
	return out;
}

function findPending(messages: UIMessage[], names: readonly string[]): PendingToolCall | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const msg = messages[m]!;
		for (let p = 0; p < msg.parts.length; p++) {
			const part = msg.parts[p]!;
			if (isToolUIPart(part) && part.state === "input-available") {
				const tool = part.type.slice("tool-".length);
				if (names.includes(tool)) {
					return { toolCallId: part.toolCallId as string, tool, input: part.input };
				}
			}
		}
	}
	return null;
}

export function findPendingToolCall(messages: UIMessage[]): PendingToolCall | null {
	return findPending(messages, QUESTION_TOOLS);
}

// ─── Turn activity label ──────

/** The transcript's turn-activity shimmer text: what the teacher is doing RIGHT NOW. */
const ACTIVITY_LABELS: Record<string, string> = {
	read: "Reading a file…",
	ls: "Listing a directory…",
	find: "Finding files…",
	grep: "Searching file contents…",
	research: "Dispatching research…",
	demo: "Building a demo…",
	visual: "Making a visual…",
	pdf: "Reading a PDF…",
	plan_init: "Drawing up the plan…",
	probe_done: "Concluding the assessment…",
};

/** The activity label for ONE running tool: the live tool-input card carries it inline — spinner + shimmered label on the card itself */
export function toolActivityLabel(tool: string): string {
	if ((QUESTION_TOOLS as readonly string[]).includes(tool)) return "Writing a question…";
	return ACTIVITY_LABELS[tool] ?? "Working…";
}



