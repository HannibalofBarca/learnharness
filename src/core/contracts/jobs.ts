/** Sub-agent job contracts — the async ack-and-steer protocol Part of the domain-split contracts (src/core/contracts/) */
import type { CallUsage } from "./chat.ts";
import type { LhMessage, LhMarkerMessage } from "../native-messages.ts";
import { newHandoffMessage } from "../native-messages.ts";

// ─── Async sub-agent jobs ────────────

export type JobKind = "research" | "demo" | "visual" | "pdf";
export type JobStatus = "running" | "done" | "error";

export interface JobRecord {
	id: string;
	kind: JobKind;
	chatId: string;
	/** The tool part this job fulfills. */
	toolCallId: string;
	/** Dispatch-time arguments, saved before spawn. Older jobs resolve from history. */
	input?: unknown;
	/** Session-owned delivery, independent of the worker's terminal outcome. */
	delivery?: { kind: "result" | "abort"; status: "pending" | "delivered" };
	/** Worker computation only; a pending delivery does not keep it running. */
	status: JobStatus;
	/** Latest human-readable activity line, e.g. `web_search: "sigma.js v3"`. */
	activity: string;
	createdAt: string;
	updatedAt: string;
	/** The sub-agent's result (steer-artifact payload). */
	result?: unknown;
	error?: string;
	/** Money channel: accumulated token usage of the sub-agent's run, written by the runner as steps complete. */
	usage?: JobUsage;
}

/** A sub-agent run's accumulated usage — the same accounting shape as a chat turn (contracts/chat.ts CallUsage) */
export interface JobUsage {
	/** The model that ran the sub-agent, provider-qualified. */
	model: string;
	/** Running totals summed over the run's model calls so far. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	cacheReadTokens: number | undefined;
	cacheWriteTokens: number | undefined;
	reasoningTokens: number | undefined;
	cacheWrite1hTokens?: number;
	/** Individual calls for current-catalog per-call tier pricing. */
	calls?: CallUsage[];
	/** How many model calls the run has made (each bills separately). */
	steps: number;
	/** The MOST RECENT model call's accounting: the per-blob context line reads last-step input+output against the model's LIVE catalog limit (server-joined */
	lastStep?: CallUsage;
}





export interface ResearchResult {
	brief: string;
	sources: { title: string; url: string }[];
}


export interface DemoResult {
	title: string;
	/** Self-contained single-file HTML/JS document (sandboxed-iframe ready). */
	html: string;
	/** The builder sub-agent headlessly executed the demo before delivery. */
	tested: true;
	notes?: string;
}


export interface VisualResult {
	/** Complete SVG markup (verified by the maker looking at the render). */
	svg: string;
	notes?: string;
}


export interface PdfResult {
	path: string;
	question: string;
	/** The distilled brief. */
	brief: string;
	/** Pages the reader actually READ — extract or render output entered the loop. */
	pagesRead: number[];
	/** Every page whose content entered the loop, search-hit context lines included — the full audit set (the brief's citations may point here). */
	pagesConsulted: number[];
}

// ─── Sub-agent steer messages (THE ASYNC PROTOCOL §3–4) ───────────────────── Wave B: steers are NATIVE record messages

/** Message metadata marking a sub-agent steer (contracts.ts §3). */
export interface SubagentResultMeta {
	jobId: string;
	kind: JobKind;
	toolCallId: string;
	/** Present only on an abort steer: the learner aborted the job (it lands as error "Aborted by learner") */
	aborted?: true;
}

/** The data-subagent-artifact part payload: what the UI renders. */
export interface SubagentArtifactData {
	kind: JobKind;
	result: ResearchResult | DemoResult | VisualResult | PdfResult;
	/** The learner's pinned UI state (invert switch) riding the record. */
	ui?: { inverted?: boolean };
}

/** A result steer's marker details: the UI's meta + artifact in one payload (the projection splits it into metadata + data part). */
export interface SteerDetails extends SubagentResultMeta {
	result: ResearchResult | DemoResult | VisualResult | PdfResult;
	/** LEARNER UI state pinned onto the artifact: the invert switch's position, persisted so navigating away and back (or restarting) keeps it. */
	ui?: { inverted?: boolean };
}

/** Set a steer message's ui.inverted (pure): returns a NEW message array with the target's details updated */
export function setSteerUiInverted(
	messages: readonly LhMessage[],
	messageId: string,
	inverted: boolean,
): LhMessage[] {
	return messages.map((m) => {
		if (m.id !== messageId) return m;
		const d = (m as LhMarkerMessage).details as Partial<SteerDetails> | undefined;
		if (!d || (d.kind !== "demo" && d.kind !== "visual")) return m;
		return { ...m, details: { ...d, ui: { ...d.ui, inverted } } } as LhMessage;
	});
}

/** Anything the wake pipeline may queue and deliver — a native marker. */
export type SteerMessage = LhMarkerMessage;

/** Whether a result is the failure shape (html/svg empty, failure brief). */
export function isSubagentFailure(
	kind: JobKind,
	result: ResearchResult | DemoResult | VisualResult | PdfResult,
): boolean {
	if (kind === "research") {
		const r = result as ResearchResult;
		return r.sources.length === 0 && /^Research failed:/i.test(r.brief);
	}
	if (kind === "demo") {
		const r = result as DemoResult;
		return typeof r.html !== "string" || r.html.length === 0;
	}
	if (kind === "pdf") {
		const r = result as PdfResult;
		return /^PDF failed:/i.test(r.brief);
	}
	const r = result as VisualResult;
	return typeof r.svg !== "string" || r.svg.length === 0;
}

/** The model-facing text of a steer: what the result IS, what to do with it. */
function steerText(kind: JobKind, result: ResearchResult | DemoResult | VisualResult | PdfResult): string {
	if (isSubagentFailure(kind, result)) {
		if (kind === "research")
			return `${(result as ResearchResult).brief}\n\nContinue with what you can establish and flag the uncertainty to the learner.`;
		if (kind === "demo")
			return `The demo "${(result as DemoResult).title}" could not be built: ${
				(result as DemoResult).notes ?? "unknown reason"
			}. Fall back to explaining in prose; if the brief was the problem, re-call demo with a tighter one.`;
		if (kind === "pdf")
			return `${(result as PdfResult).brief}\n\nContinue with what you can establish from the session and flag the gap to the learner.`;
		return `The figure could not be made: ${(result as VisualResult).notes ?? "unknown reason"}. Fall back to prose or mermaid, or re-call visual with a tighter brief.`;
	}
	if (kind === "research")
		return `Research complete — the researcher's full brief follows. Weave it into the lesson and cite its sources when you use its findings:\n\n${(result as ResearchResult).brief}`;
	if (kind === "pdf")
		return `PDF reading complete — the reader's brief on "${(result as PdfResult).path}" follows, with page citations. Weave it into the lesson and cite pages when you use it:\n\n${(result as PdfResult).brief}`;
	if (kind === "demo")
		return `The demo "${(result as DemoResult).title}" is built, headlessly tested, and rendered in the lesson. Builder notes: ${
			(result as DemoResult).notes ?? "(none)"
		}.\nTeach with it — reference its controls by name and point the learner at what to try.`;
	return `The figure is drawn, verified by inspection, and rendered in the lesson. Maker notes: ${
		(result as VisualResult).notes ?? "(none)"
	}.\nReference its elements as you teach.`;
}

/** Build the steer message for a finished job (pure — shared by the runner, the wake pipeline, and tests). */
export function buildSubagentSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
	result: ResearchResult | DemoResult | VisualResult | PdfResult,
): SteerMessage {
	return {
		id: `steer_${job.id}`,
		role: "custom",
		customType: "subagent-steer",
		content: steerText(job.kind, result),
		display: true,
		details: {
			jobId: job.id,
			kind: job.kind,
			toolCallId: job.toolCallId,
			result,
		},
		timestamp: Date.now(),
	};
}



// ─── the probe handoff steer (the probe→teach split, docs/probe-teach-split.md §2) ── probe_done's execute queues this through the same wake pipeline

export function buildProbeHandoffSteer(chatId: string): SteerMessage {
	return newHandoffMessage(chatId);
}


