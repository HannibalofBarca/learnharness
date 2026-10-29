import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	estimateContextTokens,
	estimateMessageTokens,
	estimateTokens,
	newCompactionMarker,
	newUserMessage,
	type LhMessage,
} from "../src/core/index.ts";




const big = (id: string, kb = 8): LhMessage => newUserMessage(`${id}: ${"x".repeat(kb * 1024)}`);

// ─── the anchored estimator ─────────────

describe("estimateContextTokens (usage-anchored, pi's law)", () => {
	const usageAssistant = (id: string, total: number, trailing = false): LhMessage =>
		({
			id,
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: { input: total - 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: trailing ? "aborted" : "toolUse",
			timestamp: 1,
		}) as never;

	it("anchors on the last assistant's provider-reported usage and chars/4-estimates ONLY the tail", () => {
		const msgs = [
			newUserMessage(`${"x".repeat(400_000)}`), // 100k chars of DROPPED-span text
			usageAssistant("a1", 30_000),
			newUserMessage("y".repeat(4_000)), // 1k estimated tokens AFTER the anchor
		] as LhMessage[];
		// ^ newUserMessage signature: (text, ts?) — second arg timestamp
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex !== null, true);
		assert.equal(est.usageTokens, 30_000);
		assert.equal(est.trailingTokens, 1_000);
		assert.equal(est.tokens, 31_000); // the 100k chars before the anchor are NOT re-estimated
	});

	it("skips aborted and all-zero-usage assistants when hunting the anchor", () => {
		const msgs = [
			usageAssistant("a1", 30_000),
			usageAssistant("a2", 99_999, true), // aborted after the real one
			{ ...usageAssistant("a3", 0), stopReason: "toolUse" }, // zero usage
		] as LhMessage[];
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex, 0);
		assert.equal(est.tokens, 30_000 + estimateMessageTokens(msgs[1]!) + estimateMessageTokens(msgs[2]!));
	});

	it("refuses anchors older than the newest compaction marker (pre-cut usage is not truth)", () => {
		const marker = newCompactionMarker("summary text", {
			firstKeptMessageId: "m1",
			tokensBefore: 500_000,
			at: "2026-10-05T00:00:00.000Z",
		});
		const msgs = [usageAssistant("a1", 500_000), marker as LhMessage, newUserMessage("kept tail")] as LhMessage[];
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex, null, "the marker invalidates every anchor behind it");
	});

	it("unanchored (no usage at all): the plain heuristic over everything", () => {
		const msgs = [big("m1", 4), big("m2", 4)] as LhMessage[]; // 2 × 4,116ish chars
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex, null);
		assert.equal(est.tokens, estimateTokens(msgs));
	});
});
