/** Chat-session contracts — records, summaries, UI extension points Part of the domain-split contracts (src/core/contracts/) */
import type { ThinkingLevel } from "../agent-types.ts";
import type { LhMessage } from "../native-messages.ts";
import type { Phase3 } from "../phases.ts";
import type { PlanNodeStatus, PlanTree } from "./plan.ts";
import type { EmissionStats } from "./graph.ts";

// ─── Chat records (the session store's on-disk format) ───────────────────────

/** One persisted session: data/chats/<id>.json. */
/** The session's kind: "teach" is the default and ABSENT on pre-practice records (no migration — absence reads as teach) */
export type ChatKind = "teach" | "practice" | "code";

export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: LhMessage[];
	/** The session's kind — absent = teach (pre-practice records). */
	kind?: ChatKind;
	/** Coding chats: the workspace folder the tutor runs in (absolute). */
	workspace?: string;
	/** Coding chats: the lesson chat that opened this one. */
	lessonChatId?: string;
	/** The learning-tree node this session works on (learning-tree.ts). */
	branchId?: string;
	/** The session's plan tree (vision §2) — written by plan tools via saveTree. */
	tree?: PlanTree;
	/** Append-only usage log: one entry per model turn. */
	turns?: TurnUsage[];
	/** Append-only background-extraction usage log: one entry per finished pipeline run on THIS chat — extraction is real spend too. */
	extractions?: ExtractionRunUsage[];
	/** Per-chat model/thinking overrides for the conversation agents. */
	settings?: ChatSettings;
	/** SCHEMA STAMP: LAZY v1 — existing records stay unstamped (absence reads as v1); every write stamps the current version. */
	version?: number;
}

/** The chat record format this build writes and understands. */
export const CURRENT_CHAT_VERSION = 1;

/** The conversation agents' runtime model choice: a per-chat override of config.ts's pinned prober/teacher spec. */
export interface ChatSettings {
	/** pi-ai catalog coordinates: the provider that owns the model. */
	model?: { provider: string; id: string };
	/** pi thinking level — must be in the chosen model's supported list (getSupportedThinkingLevels; enforced by the settings route). */
	thinkingLevel?: ThinkingLevel;
}


// ─── Background-extraction usage (the money channel, extraction side) ────────

/** One pipeline stage's model usage — the stage's model + every step it billed (CallUsage per agent step). */
export interface ExtractionStageUsage {
	/** The model that ran this stage, provider-qualified ("provider:id") for key-independent Pi catalog lookup at read time. */
	model: string;
	steps: CallUsage[];
}

/** One finished (or failed mid-flight) extraction run's usage record. */
export interface ExtractionRunUsage {
	/** The run's registry startedAt (ms) — the idempotency key. */
	startedAt: number;
	at: string;
	durationMs: number;
	/** What the run merged into the graph; absent when it failed first. */
	stats?: EmissionStats;
	/** Model usage per stage, in pipeline order (merger is deterministic — no model call, no entry). */
	stages: {
		extractor: ExtractionStageUsage;
		auditor: ExtractionStageUsage;
	};
}

// ─── Usage accounting (the money channel) ─────────────────────────────────────

/** One model call's token accounting — the SDK's LanguageModelUsage flattened to the fields we persist (undefined = provider didn't report */
export interface CallUsage {
	/** Pi-normalized fresh input tokens; cache buckets are disjoint. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	/** Cached input tokens READ (billed at the cache-read rate, if any). */
	cacheReadTokens: number | undefined;
	/** Input tokens written to the cache this call (OpenRouter bills writes for some providers; undefined = not reported/not billed). */
	cacheWriteTokens: number | undefined;
	/** Subset of cacheWriteTokens written with one-hour retention. */
	cacheWrite1hTokens?: number;
	/** The reasoning portion of the output tokens. */
	reasoningTokens: number | undefined;
}

/** One billing turn: one full invocation of the teacher (a client turn or a wake turn — same handler, same log). */
export interface TurnUsage {
	/** Unique per REQUEST (turn): one invocation of the handler — the idempotency key for the append-only log. */
	id: string;
	/** The assistant message the turn produced — provenance, keys this entry to the transcript (the block this turn "belongs" to). */
	messageId: string;
	at: string;
	/** The model that ran the turn, provider-qualified ("provider:id") for key-independent Pi catalog lookup at read time. */
	model: string;
	/** One entry per agent step (model call) in this turn. */
	steps: CallUsage[];
}

// ─── Plan blocks (the plan lives in the chat) ────────────────────────────────

/** Payload of the persisted `data-plan-block` UI part: a SNAPSHOT of the plan at the moment it changed, rendered as a block in the chat flow. */

/** The model-facing text of the probe→teach handoff wake (the custom-message scheme): the wake message carries only the data-probe-handoff part */
export const HANDOFF_TEXT =
	"Next: plan the full teaching arc from my current understanding to the goal understanding. " +
	"Apply the teaching methodology in your system prompt, and find the optimal way to teach me this. " +
	"Find the unconditional truths, plan the motivated derivations/discoveries, so every reasoning step has to land as obviously true. " +
	"Take your time here and really think this through. " +
	"When it's genuinely reasoned out, call plan_init and present the plan; I'll accept it or ask for changes.";

// ─── Practice sessions — marker + ack texts ────────────── Single-sourced here per the marker law

/** The model-facing register of a thinking submission (newThinkingMessage prefixes the learner's text with this label). */
/** The single submission label: one send lane — whether a submission claims an answer is read from the text, not declared by a button. */
export const THINKING_LABEL = "Your thinking";

/** The conclude tool's ack — shared by the executed call (agent layer) and the dismissal-synthesized pair (input-events) */
export const CONCLUDE_ACK_TEXT =
	"Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.";

/** The learner's explicit move-on signal: the model-facing text of the practice-next marker — single-sourced like THINKING_LABEL. */
export const NEXT_PROBLEM_TEXT =
	"[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.";

/** The compaction marker's model-facing header. */
export const COMPACTED_HISTORY_HEADER =
	"[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.";


export interface PlanBlockData {
	/** Only "full" survives: the plan renders IN FLOW once, at authoring. */
	kind: "full";
	at: string;
	/** The current node at snapshot time (the glow target; null = none). */
	current: string | null;
	/** All nodes of the authored tree. */
	nodes: Array<{ id: string; title: string; status: PlanNodeStatus }>;
	edges: Array<{ from: string; to: string }>;
}

/** The list view's shape (messageCount instead of full messages) + the per-session status the picker renders. */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Normalized kind (absent record field reads as teach). */
	kind: ChatKind;
	messageCount: number;
	/** The session's current phase, derived from the stored plan tree. */
	phase: Phase3;
	/** An unanswered quiz/ask question is waiting for the learner. */
	pendingQuestion: boolean;
	/** Practice sessions: a posed problem with no conclude — the sidebar meta's "Problem waiting". */
	pendingProblem: boolean;
	/** The record's model-control settings — rides the list payload via the summary spread (the picker never needs it from here */
	settings?: ChatSettings;
}

/** The sidebar's session row: a summary + live liveness. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
	/** Live compaction liveness (turn-liveness's twin): true while a background context compaction holds the chat's model gate. */
	compacting: boolean;
}

// ─── Artifact renderer registry (client extension point) ────────────────────

/** components/chat.tsx renders any tool part it doesn't specially handle via components/artifacts/index.ts's registry, keyed by tool name ("research" */
export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
		/** The pose-side fold: the whole problem-call arguments joined onto the conclude part by projectView — the observability drawer's data. */
		problemInput?: unknown;
		/** The view-seam join for conclude cards: the modelSolution committed at POSE time, folded onto the part by projectView */
		reveal?: unknown;
	};
}
