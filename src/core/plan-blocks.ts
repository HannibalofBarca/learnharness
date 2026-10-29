/** Plan-block emission (docs/probe-teach-split.md §6): the INTERIM plan presentation seam. */

import type { PlanBlockData, PlanTree } from "./contracts.ts";
import { derivePlanStatusesLh } from "./contracts.ts";
import type { LhMessage } from "./native-messages.ts";
import { newPlanBlockMessage } from "./native-messages.ts";
import type { ToolResultMessage } from "./agent-types.ts";


/** The snapshot payload: statuses derived AT EMISSION time from the transcript — the block never re-derives. */
function snapshot(tree: PlanTree, messages: readonly LhMessage[]): PlanBlockData {
	const statuses = derivePlanStatusesLh(tree, messages);
	return {
		kind: "full",
		at: new Date().toISOString(),
		current: statuses.current,
		nodes: tree.nodes.map((n) => ({
			id: n.id,
			title: n.title,
			status: statuses.current === n.id ? "current" : statuses.visited.has(n.id) ? "visited" : "upcoming",
		})),
		edges: tree.edges.map((e) => ({ from: e.from, to: e.to })),
	};
}

/** The record's plan-block markers, keyed by the plan_init call they present — the idempotency set for emission. */
function emittedPlanBlockCalls(messages: readonly LhMessage[]): Set<string> {
	const out = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as { customType?: string; details?: { planCallId?: unknown } };
		if (marker.customType === "plan-block" && typeof marker.details?.planCallId === "string") {
			out.add(marker.details.planCallId);
		}
	}
	return out;
}

/** The native emission seam (pure): ONE plan-block marker per TURN — for the turn's LAST successful plan_init call (a same-turn rewrite presents once */
export function planBlocksFor(
	record: readonly LhMessage[],
	newMessages: readonly LhMessage[],
	tree: PlanTree | null | undefined,
	transcript: readonly LhMessage[],
): LhMessage[] {
	if (!tree || tree.nodes.length === 0) return [];
	const emitted = emittedPlanBlockCalls(record);
	let last: { toolCallId: string } | null = null;
	for (const m of newMessages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage & { id: string };
		if (result.toolName !== "plan_init") continue;
		const ok = (result.details as { ok?: unknown } | undefined)?.ok;
		if (ok !== true) continue;
		if (emitted.has(result.toolCallId)) continue;
		last = { toolCallId: result.toolCallId };
	}
	if (!last) return [];
	return [newPlanBlockMessage(last.toolCallId, snapshot(tree, transcript))];
}
