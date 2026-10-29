"use client";

/** The Planner page (ClaudeHarness): the learning tree canvas, and the planner's Claude Code terminal underneath */

import { ClaudeTerminal } from "@/components/claude-terminal";
import { LearningTree } from "@/components/learning-tree";

export function Planner() {
	return (
		<div className="flex h-dvh flex-col" data-testid="planner">
			<div className="lh-drag flex h-15 shrink-0 items-center border-b border-border px-6">
				<h1 className="font-ui text-sm font-medium">Planner</h1>
				<span className="ml-3 text-xs text-muted-foreground">Your learning tree. Plan with Claude below — it reads your docs, shapes the tree, and opens sessions.</span>
			</div>
			<div className="min-h-0 flex-1">
				<LearningTree />
			</div>
			<ClaudeTerminal chatId="planner" />
		</div>
	);
}
