/** Extraction coverage — the pure core. */

import { createHash } from "node:crypto";

import type { CoverageEntry } from "./contracts/graph.ts";
import { failedOutputCallIds, userFacingTextOf, type LhMessage } from "./native-messages.ts";

/** The extraction-relevant lines of ONE native message — the shared seam between the extractor's prompt and messageFingerprint (coverage). */
export function messageViewLines(
	message: LhMessage,
	mid: string,
	failedOutputCalls: ReadonlySet<string> = failedOutputCallIds([message]),
): string[] {
	const lines: string[] = [];
	if ((message as { role?: string }).role !== "assistant") return lines;
	for (const text of userFacingTextOf((message as { content: unknown }).content, failedOutputCalls)) {
		lines.push(`TEACHER [${mid}] ${text.trim()}`);
	}
	return lines;
}


/** Tokens of a message's view — chars/4, ceil, the app-wide estimate. */
function viewTokens(lines: string[]): number {
	return Math.ceil(lines.join("\n").length / 4);
}

/** A message's coverage fingerprint: sha256 of role + its view lines (the teacher prose, with the message id as the tag). */
export function messageFingerprint(message: LhMessage, failedOutputCalls?: ReadonlySet<string>): string {
	const h = createHash("sha256");
	h.update(JSON.stringify([(message as { role?: string }).role, messageViewLines(message, message.id, failedOutputCalls)]));
	return h.digest("hex");
}

/** One message's coverage-relevant projection. */
interface CoverageSlot {
	message: LhMessage;
	fp: string;
	tokens: number;
}

/** Fingerprint a whole transcript, in order (used by the trigger, the run, and the coverage view — one derivation everywhere). */
function coverageSlots(messages: ReadonlyArray<LhMessage>): CoverageSlot[] {
	const failedOutputCalls = failedOutputCallIds(messages);
	return messages.map((message) => ({
		message,
		fp: messageFingerprint(message, failedOutputCalls),
		tokens: viewTokens(messageViewLines(message, message.id, failedOutputCalls)),
	}));
}

/** The covered-fingerprint set for one chat, from the ledger. */
function coveredSet(entries: ReadonlyArray<CoverageEntry>, chatId: string): Set<string> {
	const out = new Set<string>();
	for (const e of entries) if (e.chatId === chatId) out.add(e.fp);
	return out;
}

/** The derived state: which slots are uncovered, plus the token totals. */
export function coverageOf(
	messages: ReadonlyArray<LhMessage>,
	entries: ReadonlyArray<CoverageEntry>,
	chatId: string,
): {
	slots: CoverageSlot[];
	uncovered: number[];
	coveredTokens: number;
	uncoveredTokens: number;
	coveredCount: number;
	uncoveredCount: number;
} {
	const covered = coveredSet(entries, chatId);
	const slots = coverageSlots(messages);
	const uncovered: number[] = [];
	let coveredTokens = 0;
	let uncoveredTokens = 0;
	for (let i = 0; i < slots.length; i++) {
		const slot = slots[i]!;
		if (slot.tokens === 0) continue; // invisible (including failed output calls)
		if (covered.has(slot.fp)) coveredTokens += slot.tokens;
		else {
			uncovered.push(i);
			uncoveredTokens += slot.tokens;
		}
	}
	const visibleCount = slots.filter((s) => s.tokens > 0).length;
	return {
		slots,
		uncovered,
		coveredTokens,
		uncoveredTokens,
		coveredCount: visibleCount - uncovered.length,
		uncoveredCount: uncovered.length,
	};
}

/** Batch the uncovered teacher-prose messages into token-budgeted RUNS: consecutive slots, oldest first, greedy fill — a message is never split. */
export function batchRuns(slots: ReadonlyArray<CoverageSlot>, uncovered: ReadonlyArray<number>, budget: number): CoverageSlot[][] {
	if (budget <= 0 || uncovered.length === 0) return [];
	const runs: CoverageSlot[][] = [];
	let current: CoverageSlot[] = [];
	let currentTokens = 0;
	const flush = () => {
		if (current.length > 0) runs.push(current);
		current = [];
		currentTokens = 0;
	};
	for (const i of uncovered) {
		const slot = slots[i]!;
		if (current.length > 0 && currentTokens + slot.tokens > budget) flush();
		current.push(slot);
		currentTokens += slot.tokens;
	}
	flush();
	return runs;
}

