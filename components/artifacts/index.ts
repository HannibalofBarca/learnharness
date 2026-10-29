import type { ComponentType } from "react";
import type { ArtifactPartProps } from "@/src/core";
import { DemoCard } from "@/components/artifacts/demo-card";
import { JobCard, PdfJobCard } from "@/components/artifacts/job-card";
import { VisualCard } from "@/components/artifacts/visual-card";
import { ProbeDoneCard } from "@/components/artifacts/probe-done-card";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { ProblemCard, ConcludeCard } from "@/components/practice-cards";

/** Artifact renderer registry — the extension point for tool-part UI. */
export const artifactRenderers: Record<string, ComponentType<ArtifactPartProps>> = {
	research: JobCard,
	pdf: PdfJobCard, // sources v0 — live smoke 2026-09-19 caught the gap: without this the tool-pdf dispatch part rendered nothing
	// plan_* parts render nothing inline by design: the phase seam is a message-level boundary, drawn by PhaseDivider in chat.tsx.
	demo: DemoCard,
	visual: VisualCard,
	// The probe conclusion: the assessment belongs to the learner as much as to the transcript (docs/probe-teach-split.md §2).
	probe_done: ProbeDoneCard,
	// The learner-filesystem set (sources v1): one quiet expandable tool-call card each — collapsed one-liner (tool name + headline argument)
	read: ToolCallCard,
	ls: ToolCallCard,
	find: ToolCallCard,
	grep: ToolCallCard,
	// The practice pair: the pose renders the statement ONLY (the commitment lives in the call's arguments and never renders)
	problem: ProblemCard,
	conclude: ConcludeCard,
	// The prober's graph tools: same quiet expandable card — collapsed one-liner (tool name + the session id for list_propositions)
	list_sessions: ToolCallCard,
	list_propositions: ToolCallCard,
};
