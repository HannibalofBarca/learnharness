import type { AssistantMessage } from "./agent-types.ts";
import type { LhMessage } from "./native-messages.ts";

/** Latest completed conversation measurement, never a request-size estimate. */
export function measuredContextTokens(
	messages: readonly LhMessage[],
	incompleteIds: ReadonlySet<string> = new Set(),
): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "custom" && message.customType === "compaction") return null;
		if (message.role !== "assistant" || incompleteIds.has(message.id)) continue;
		const assistant = message as AssistantMessage;
		if (!["stop", "length", "toolUse"].includes(assistant.stopReason)) continue;
		const usage = assistant.usage;
		if (!usage) continue;
		const buckets = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
		if (buckets.some((value) => !Number.isFinite(value) || value < 0)) continue;
		const tokens = buckets.reduce((sum, value) => sum + value, 0);
		if (tokens > 0) return tokens;
	}
	return null;
}
