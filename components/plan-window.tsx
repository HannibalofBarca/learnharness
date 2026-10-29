"use client";

import { useId, useMemo } from "react";
import { derivedNodeStatus, derivePlanStatuses } from "@/src/core";
import {
	PlanDiagram,
	GRAPH_PAD,
	latestTree,
	TEXT_CAP_SCALE,
	type PopupMessage,
} from "@/components/plan-block";

/** THE PLAN MARGINALIA: the plan's ambient presence in the session view — the successor of the old fixed corner card. */

const MARGIN_PAD = GRAPH_PAD + 16;

/** True when the transcript holds a plan tree. */
export function planExists(messages: readonly PopupMessage[]): boolean {
	const tree = latestTree(messages);
	return !!tree && tree.nodes.length > 0;
}

export function PlanMarginalia({ messages }: { messages: readonly PopupMessage[] }) {
	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const tree = useMemo(() => latestTree(messages), [messages]);
	const statuses = useMemo(
		() => (tree ? derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]) : null),
		[tree, messages],
	);
	if (!tree || tree.nodes.length === 0) return null; // no plan yet: nothing in the margin
	const statusOf = (id: string) => (statuses ? derivedNodeStatus(statuses, id) : "upcoming");
	return (
		<PlanDiagram
			nodes={tree.nodes}
			edges={tree.edges}
			statusOf={statusOf}
			glowId={statuses?.current ?? null}
			markerId={markerId}
			pad={MARGIN_PAD}
			textCapScale={TEXT_CAP_SCALE}
			fill
		/>
	);
}
