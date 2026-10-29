import type { AgentTool, AgentToolResult } from "../core/agent-types.ts";
import type { Static, TSchema } from "typebox";
import { CONCLUDE_ACK_TEXT } from "../core/contracts/chat.ts";

/** tool-execute — the execution machinery every server-side lh tool shares, expressed natively */

/** System-level per-call timeout: pi passes every run's AbortSignal to tool execute, but the signal only lands at a step boundary */
const TOOL_TIMEOUT_MS = 30_000;
/** Test seam (runner.ts's pdfModelOverride idiom). */
const toolTimeoutMs = { current: TOOL_TIMEOUT_MS };

/** How long an aborted/timed-out call may take to settle on its own before the hard reject lands */
const TOOL_ABORT_GRACE_MS = 250;

function runWithAbortGuard<T>(
	toolName: string,
	run: (signal: AbortSignal) => T | Promise<T>,
	parent: AbortSignal | undefined,
): Promise<T> {
	const controller = new AbortController();
	const forwardAbort = () => controller.abort();
	if (parent) {
		if (parent.aborted) controller.abort();
		else parent.addEventListener("abort", forwardAbort, { once: true });
	}
	const timeoutMs = toolTimeoutMs.current;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const humanTimeout = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const cleanup = () => {
		clearTimeout(timer);
		if (graceTimer) clearTimeout(graceTimer);
		parent?.removeEventListener("abort", forwardAbort);
	};
	return new Promise<T>((resolve, reject) => {
		const settle = (fn: () => void) => {
			controller.signal.removeEventListener("abort", onAbort);
			if (graceTimer) clearTimeout(graceTimer);
			fn();
		};
		const onAbort = () => {
			// Cooperative tools poll the signal and settle with partial results within a tick or two (the fs tools check per file)
			graceTimer = setTimeout(
				() =>
					reject(
						new Error(
							parent?.aborted
								? "Operation aborted"
								: `Tool "${toolName}" timed out after ${humanTimeout} — the result was discarded`,
						),
					),
				TOOL_ABORT_GRACE_MS,
			);
		};
		controller.signal.addEventListener("abort", onAbort, { once: true });
		if (controller.signal.aborted) onAbort(); // an already-aborted signal never fires listeners
		Promise.resolve()
			.then(() => run(controller.signal))
			.then(
				(v) => settle(() => resolve(v)),
				(e) => settle(() => reject(e)),
			);
	})
		.finally(cleanup);
}

/** The 1.0-native authoring-failure result (pi convention, agent-core 1.0): return an isError result instead of throwing */
export function invalidInputResult(
	toolName: string,
	problems: string[],
): AgentToolResult<{ tool: string; problems: string[] }> {
	return {
		content: [
			{
				type: "text",
				text: `Invalid tool input for tool "${toolName}":\n${problems.map((p) => `- ${p}`).join("\n")}`,
			},
		],
		isError: true,
		details: { tool: toolName, problems },
	};
}

/** Rich tool-result escape hatch: a tool whose result includes IMAGES (the read tool reading an image file) returns this shape instead of a plain value */
interface ImageFileResult {
	text: string;
	images?: { data: string; mimeType: string }[];
	/** The record-facing result (client rendering / persistence). */
	details?: unknown;
}

function isImageResult(v: unknown): v is ImageFileResult {
	return (
		typeof v === "object" && v !== null && "text" in v && typeof (v as ImageFileResult).text === "string"
	);
}

/** Map a tool body's return to the native AgentToolResult — the parity the old toPiTool tail owned: string results pass verbatim to the model */
function toToolResult(result: unknown): AgentToolResult<unknown> {
	if (isImageResult(result)) {
		return {
			content: [
				{ type: "text", text: result.text },
				...(result.images ?? []).map((img) => ({
					type: "image" as const,
					data: img.data,
					mimeType: img.mimeType,
				})),
			],
			details: result.details ?? null,
		};
	}
	return {
		content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
		details: result,
	};
}

/** What a server-executed tool's body receives: the call id + the guard's combined signal (run abort + per-call timeout) for cooperative polling. */
interface ToolExecuteContext {
	toolCallId: string;
	signal?: AbortSignal;
}

/** Build a native AgentTool execute from a tool body — the guard (timeout + abort cascade) plus the shared result mapping */
export function serverExecute<P extends TSchema>(
	toolName: string,
	schema: P,
	run: (input: Static<P>, ctx: ToolExecuteContext) => unknown,
): AgentTool<any>["execute"] {
	// The returned execute is deliberately typed loose (params: unknown) so it satisfies every AgentTool slot
	return async (toolCallId, input: unknown, signal) =>
		toToolResult(
			await runWithAbortGuard(toolName, (toolSignal) => run(input as Static<P>, { toolCallId, signal: toolSignal }), signal),
		);
}

/** The synthetic question-tool result (in-memory only; the record's tool part keeps no output until the learner answers). */
export function questionResult(): AgentToolResult<null> {
	return {
		content: [
			{
				type: "text",
				text: "Question posed — the turn ends here; the learner's graded answer arrives as this call's result.",
			},
		],
		details: null,
		terminate: true,
	};
}

/** The practice pose's ack: unlike a question, this result is FINAL — it persists (persistTurn filters only QUESTION_TOOLS placeholders) */
export function problemResult(): AgentToolResult<null> {
	return {
		content: [
			{
				type: "text",
				text: "Problem posed — the turn ends here; the learner's thinking traces and answer commits arrive as labeled messages.",
			},
		],
		details: null,
		terminate: true,
	};
}

/** The conclude ack: NOT terminate — the turn continues so the same reply can reveal + pose the next problem. */
export function concludeResult(): AgentToolResult<null> {
	return {
		content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
		details: null,
	};
}
