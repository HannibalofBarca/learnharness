/** COMPACTION: the context-fitting mechanic, with a bounded local port of Pi coding-agent 1.4.0 cutoff selection. */

import { COMPACTED_HISTORY_HEADER } from "./contracts/chat.ts";
import type { LhMessage, LhMarkerMessage } from "./native-messages.ts";
import { newMessageId } from "./native-messages.ts";
import type { AgentMessage } from "./agent-types.ts";
import type { AssistantMessage } from "./agent-types.ts";

// ─── constants ────────────────────────────────





// ─── token estimation (pi's law: usage-anchored, chars/4 only for the tail) ─

/** Context tokens from a provider-reported usage block */
export function calculateContextTokens(usage: {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}): number {
	return (
		usage.totalTokens ||
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	);
}

/** Pi 1.4.0's heuristic: text + thinking + toolCall name/args for assistants, content text plus a fixed image allowance for other roles. */
export function estimateMessageTokens(message: LhMessage | AgentMessage): number {
	const content: unknown = (message as { content?: unknown }).content;
	let chars = 0;
	if ((message as { role?: string }).role === "assistant") {
		for (const block of (Array.isArray(content) ? content : []) as Array<{
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			arguments?: unknown;
		}>) {
			if (block.type === "text") chars += block.text?.length ?? 0;
			else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
			else if (block.type === "toolCall") chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
		}
	} else {
		chars += textCharsOfContent(content);
	}
	return Math.ceil(chars / 4);
}

// Pi coding-agent 1.4.0 estimateTokens: fixed image allowance, NOT a measurement of encrypted reasoning or actual provider vision tokens.
const ESTIMATED_IMAGE_CHARS = 4_800;
function textCharsOfContent(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as Array<string | { type?: string; text?: string }>) {
		if (typeof block === "string") chars += block.length;
		else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
		else if (block?.type === "text") chars += block.text?.length ?? 0;
	}
	return chars;
}

/** The newest assistant message carrying VALID provider-reported usage (pi's rule: skip aborted/error messages and all-zero usage */
function lastAssistantUsageIndex(
	messages: readonly (LhMessage | AgentMessage)[],
): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role === "custom" && (m as LhMarkerMessage).customType === "compaction") return null;
		if ((m as { role?: string }).role !== "assistant") continue;
		const a = m as AssistantMessage & { stopReason?: string };
		if (a.stopReason === "aborted" || a.stopReason === "error") continue;
		if (calculateContextTokens((a.usage ?? {}) as Parameters<typeof calculateContextTokens>[0]) === 0) continue;
		return i;
	}
	return null;
}

interface ContextTokenEstimate {
	/** The estimate the trigger should compare against the threshold. */
	tokens: number;
	/** Provider-reported tokens from the usage anchor (0 when unanchored). */
	usageTokens: number;
	/** chars/4-estimated tokens after the anchor (or everything, unanchored). */
	trailingTokens: number;
	/** Index of the usage anchor, or null (diagnostics). */
	lastUsageIndex: number | null;
}

/** THE trigger estimator (pi's estimateContextTokens): anchor on the last assistant usage the provider reported — prompt, tools */
export function estimateContextTokens(
	messages: readonly (LhMessage | AgentMessage)[],
): ContextTokenEstimate {
	const anchor = lastAssistantUsageIndex(messages);
	if (anchor === null) {
		let trailing = 0;
		for (const m of messages) trailing += estimateMessageTokens(m);
		return { tokens: trailing, usageTokens: 0, trailingTokens: trailing, lastUsageIndex: null };
	}
	const anchored = messages[anchor]! as AssistantMessage;
	const usageTokens = calculateContextTokens(anchored.usage as Parameters<typeof calculateContextTokens>[0]);
	let trailing = 0;
	for (let i = anchor + 1; i < messages.length; i++) trailing += estimateMessageTokens(messages[i]!);
	return { tokens: usageTokens + trailing, usageTokens, trailingTokens: trailing, lastUsageIndex: anchor };
}

/** Estimate a whole message list (the plain heuristic — cut-walk use). */
export function estimateTokens(messages: readonly (LhMessage | AgentMessage)[]): number {
	let total = 0;
	for (const m of messages) total += estimateMessageTokens(m);
	return total;
}

// ─── the cut walk ────────────────────────────────────────────────────────────



// ─── the marker ──────────────────────────────────────────────────────────────

/** The compaction marker's details (UI payload — never model-visible; the model sees content, the header + summary). */
export interface CompactionDetails {
	/** Record id of the first KEPT message: the projection renders the summary, then everything from this message onward. */
	firstKeptMessageId: string;
	/** The estimated context tokens that triggered this compaction (provenance for the divider's tooltip/dialog). */
	tokensBefore: number;
	/** provider:id of the model that wrote the summary. */
	model?: string;
	/** ISO timestamp of the compaction moment. */
	at: string;
}

/** Build the compaction marker. */
export function newCompactionMarker(summary: string, details: CompactionDetails): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "compaction",
		content: `${COMPACTED_HISTORY_HEADER}\n\n${summary.trim()}`,
		display: true,
		details,
		timestamp: Date.now(),
	};
}

/** The ACTIVE compaction marker: the newest one in the record (chained compactions — the last one rules */
export function activeCompactionOf(messages: readonly LhMessage[]): (LhMarkerMessage & { details: CompactionDetails }) | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as LhMarkerMessage;
		if (marker.customType === "compaction") {
			const details = marker.details as Partial<CompactionDetails>;
			if (typeof details.firstKeptMessageId === "string") {
				return marker as LhMarkerMessage & { details: CompactionDetails };
			}
		}
	}
	return null;
}


// ─── the summarizer input (pi's mirror: labeled text, truncated results) ─────



