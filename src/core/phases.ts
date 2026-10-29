/** Phase derivation (docs/probe-teach-split.md §4) — EXPLICIT EVENTS, never occupancy. */

/** The three phases of a session, as the picker / header / dividers see them. */
export type Phase3 = "probe" | "plan" | "teach";

/** Minimal structural slice of a UI message for the phase scan: parts with a state, an input (a tool call's parsed arguments) */
interface PhaseMessage {
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}

/** A quiz call's part input carries `nodeId` iff it is tagged (teach-only — the probe quiz schema has no nodeId field). */
function taggedNodeId(input: unknown): boolean {
	return (
		typeof input === "object" &&
		input !== null &&
		typeof (input as { nodeId?: unknown }).nodeId === "string" &&
		(input as { nodeId: string }).nodeId.length > 0
	);
}

/** The phase at `upToIndex` (inclusive; default: the last message). */
export function phaseAt3(messages: readonly PhaseMessage[], upToIndex?: number): Phase3 {
	let phase: Phase3 = "probe";
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	for (let i = 0; i <= last; i++) {
		phase = advance(phase, messages[i]?.parts);
	}
	return phase;
}

/** One message's advance of the phase (pure fold step). */
function advance(
	phase: Phase3,
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }> | undefined,
): Phase3 {
	if (!parts) return phase;
	for (const part of parts) {
		// STRICTLY SEQUENTIAL: probe → plan only via a concluded probe_done, plan → teach only via the first nodeId-tagged quiz CALL (the call
		if (phase === "probe" && part.type === "tool-probe_done" && part.state === "output-available") {
			phase = "plan";
		}
		// plan → teach via the first nodeId-tagged quizzing CALL — quiz OR explain, whichever mechanic the settings armed (both carry nodeId).
		if (
			phase === "plan" &&
			(part.type === "tool-quiz" || part.type === "tool-explain") &&
			taggedNodeId(part.input)
		) {
			phase = "teach";
		}
	}
	return phase;
}

/** WHERE inside the flipping message teaching begins: plan→teach flips at the first tagged quiz/explain CALL */
export function teachStepIndex(
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown }>,
): number {
	let stepStarts = 0; // how many step-start parts seen so far
	let latest = -1; // index of the latest step-start
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part.type === "step-start") {
			stepStarts++;
			latest = i;
			continue;
		}
		if (
			(part.type === "tool-quiz" || part.type === "tool-explain") &&
			taggedNodeId(part.input)
		) {
			// The call's governing step: 0–1 step-starts seen = the message's FIRST step → -1 (the divider belongs before the whole message)
			return stepStarts <= 1 ? -1 : latest;
		}
	}
	return -1;
}

/** The phase at EVERY message index, in one forward fold — the transcript dividers render one per boundary, so phaseAt3(m */
export function phaseTimeline(messages: readonly PhaseMessage[]): Phase3[] {
	const out: Phase3[] = [];
	let phase: Phase3 = "probe";
	for (let i = 0; i < messages.length; i++) {
		phase = advance(phase, messages[i]?.parts);
		out.push(phase);
	}
	return out;
}

// ─── the native fold ───────────

import type { LhMessage } from "./native-messages.ts";

/** The phase at `upToIndex` (inclusive; default: the last message) of a NATIVE record. */
export function phaseAt3Lh(messages: readonly LhMessage[], upToIndex?: number): Phase3 {
	let phase: Phase3 = "probe";
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	for (let i = 0; i <= last; i++) {
		const m = messages[i]!;
		const role = (m as { role?: string }).role;
		if (role === "toolResult") {
			const result = m as { toolName?: string; isError?: boolean };
			if (
				phase === "probe" &&
				result.toolName === "probe_done" &&
				!result.isError
			) {
				phase = "plan";
			}
		} else if (role === "assistant") {
			const content = (m as { content?: ReadonlyArray<{ type?: string; name?: string; arguments?: unknown }> }).content ?? [];
			if (phase === "plan") {
				for (const block of content) {
					if (
						block.type === "toolCall" &&
						(block.name === "quiz" || block.name === "explain") &&
						taggedNodeId(block.arguments)
					) {
						phase = "teach";
						break;
					}
				}
			}
		}
	}
	return phase;
}
