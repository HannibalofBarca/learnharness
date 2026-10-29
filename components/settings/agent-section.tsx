"use client";
/** The Agent section: the THREE MODEL SLOTS, the tool toggles + the search-engine preference, and the prompt override switches — three GROUPS. */

import { useCallback, useEffect, useState } from "react";
import { useSettingsSaved } from "@/components/settings-signal";
import type { AgentSettings, GraphSettings } from "@/src/core";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";





/** SegmentInfo as GET /api/settings/prompts returns it. */
interface SegmentInfo {
	path: string;
	sourceText: string;
	overrideText: string | null;
	enabled: boolean;
	shared: boolean;
}



/** The quizzing mechanics (owner 2026-09-27): a segmented control, not a
 *  toggle — exactly one mechanic is ever active. `explain: true` arms
 *  free-recall (explain in, quiz out); anything else is multiple choice.
 *  `quiz` itself is never written (mechanics-managed — see quizMechanics
 *  in agent/tools.ts). Pure — exported for tests. */
function composeQuizMechanics(agent: AgentSettings | undefined, mechanics: "choice" | "free"): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, explain: mechanics === "free" } };
}

/** Compose the prober graph-tools toggle (wave 7): its own key in the
 *  agent section — never in the tool-toggles map (owner ruling). Absent =
 *  ON (the toggle discipline); the write is explicit either way, so an
 *  explicit-off record stays visible as stored. Pure — exported for tests. */
function composeGraphTools(agent: AgentSettings | undefined, on: boolean): AgentSettings {
	return { ...agent, graphTools: { enabled: on } };
}



/** The indicator under a row whose override IS the version in use. */
const PROMPT_IN_USE_HINT = "Your version is in use";

/** One section of the prompt view. */
interface PromptSection {
	id: "teacher" | "prober" | "shared";
	label: string;
	/** The one header that earns a hint: "Shared" alone is not self-evident. */
	hint?: string;
	segments: SegmentInfo[];
}

/** Split the server's per-agent segment lists into the owner's three
 *  sections. The server contract returns the shared segments in BOTH
 *  lists (same paths, same content) — the shared chunks are listed ONCE
 *  here (taken from the teacher list; identical by construction), in
 *  assembly order: the base file, then the shared fragments sorted. The
 *  agents' own chunks keep their lists' order — which IS the prompt
 *  assembly order (numeric-prefix filename sort). Pure — exported for
 *  tests. */
function sectionedSegments(view: { prober: SegmentInfo[]; teacher: SegmentInfo[] }): PromptSection[] {
	const own = (who: "prober" | "teacher") => view[who].filter((s) => !s.shared);
	return [
		{ id: "teacher", label: "Teacher", segments: own("teacher") },
		{ id: "prober", label: "Prober", segments: own("prober") },
		{
			id: "shared",
			label: "Shared",
			hint: "Used by both agents",
			segments: view.teacher.filter((s) => s.shared),
		},
	];
}

/** Compose: one prompt switch. */
function composePromptSwitch(agent: AgentSettings | undefined, path: string, on: boolean): AgentSettings {
	const prompts = { ...agent?.prompts };
	if (on) prompts[path] = true;
	else delete prompts[path];
	return { ...agent, prompts };
}


/* The section's dropdowns all mount the shared MenuShell: portaled to document.body */

export function AgentSection({
	agent,
	graph,
	onSectionChange,
}: {
	agent: AgentSettings | undefined;
	/** The `graph` section — READ ONLY here: the graphTools row composes its master switch (graph.enabled off dims + disables the row */
	graph: GraphSettings | undefined;
	/** Writes the composed WHOLE agent section (replace-PUT discipline). */
	onSectionChange: (next: AgentSettings) => void;
}) {
	const [prompts, setPrompts] = useState<{ prober: SegmentInfo[]; teacher: SegmentInfo[] } | null>(null);
	const [openSegment, setOpenSegment] = useState<string | null>(null);
	const [segmentDraft, setSegmentDraft] = useState<Record<string, string>>({});
	const [segmentStatus, setSegmentStatus] = useState<string | null>(null);

	/** Re-read the prompt-segment view — the signal seam for the 2026-09-26 state-echo fix */
	const readPrompts = useCallback(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body))
			.catch(() => {});
	}, []);

	useSettingsSaved((section) => {
		// The prompt switches write through the agent section; this view (the toggles' truth) re-reads on every agent write.
		if (section === "agent") readPrompts();
	});

	useEffect(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body))
			.catch(() => setPrompts(null));
	}, []);


	async function saveSegment(path: string, text: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			setSegmentStatus(`Save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
			return;
		}
		readPrompts();
		setSegmentStatus("Saved");
		// Auto-on: writing an override and putting it to work are ONE action — a save with the switch off was the "did something
		if (agent?.prompts?.[path] !== true) {
			onSectionChange(composePromptSwitch(agent, path, true));
		}
	}

	async function deleteSegment(path: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, { method: "DELETE" });
		if (!res.ok) {
			setSegmentStatus(`Delete failed: ${res.status}`);
			return;
		}
		// Auto-off — the mirror of save's auto-on: deleting the file while the switch is on would orphan an ON record switch.
		if (agent?.prompts?.[path] === true) {
			onSectionChange(composePromptSwitch(agent, path, false));
		}
		readPrompts();
		setSegmentStatus("Deleted");
	}


	const segmentRow = (info: SegmentInfo) => {
		const fileExists = info.overrideText !== null;
		const open = openSegment === info.path;
		// The Save affordance: clickable only when there's something to save — the draft differs from what's on disk.
		const draft = segmentDraft[info.path] ?? info.overrideText ?? "";
		const dirty = draft !== (info.overrideText ?? "");
		return (
			<div key={info.path} data-testid={`prompt-segment-${info.path}`}>
				<SettingsRow
					label={info.path}
					// Overhaul rulings: the small text states WHICH VERSION IS IN USE
					hint={info.enabled ? PROMPT_IN_USE_HINT : undefined}
					testid={`prompt-row-${info.path}`}
				>
					{/* Graying ruling: ONLY the toggle dims without an override file — the file name above stays full-contrast (the whole-row dim is dead). */}
					<span className={fileExists ? undefined : "opacity-40"}>
						<Toggle
							checked={info.enabled}
							disabled={!fileExists}
							label={`prompt ${info.path}`}
							onChange={(on) => onSectionChange(composePromptSwitch(agent, info.path, on))}
						/>
					</span>
				</SettingsRow>
				<button
					type="button"
					onClick={() => {
						setOpenSegment(open ? null : info.path);
						setSegmentStatus(null);
					}}
					className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
				>
					{open ? "Hide text" : "Show text"}
				</button>
				{open && (
					<div className="mt-1 flex flex-col gap-2">
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Source</p>
							<textarea
								readOnly
								value={info.sourceText}
								aria-label="The original instructions"
								className="h-24 w-full resize-y rounded-sm border border-border bg-muted p-2 font-ui text-xs text-muted-foreground"
							/>
						</div>
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Override</p>
							<textarea
								value={segmentDraft[info.path] ?? info.overrideText ?? ""}
								onChange={(e) => setSegmentDraft({ ...segmentDraft, [info.path]: e.target.value })}
								aria-label="Your version of the instructions"
								placeholder="Add your own instructions…"
								className="h-24 w-full resize-y rounded-sm border border-border bg-background p-2 font-ui text-xs text-foreground outline-none"
							/>
						</div>
						<div className="flex items-center gap-3">
							<button
								type="button"
								disabled={!dirty}
								onClick={() => void saveSegment(info.path, segmentDraft[info.path] ?? "")}
								className={
									dirty
										? "text-xs text-foreground underline-offset-2 hover:underline"
										: "cursor-not-allowed text-xs text-muted-foreground/40 underline-offset-2"
								}
							>
								Save
							</button>
							{fileExists && (
								<button
									type="button"
									onClick={() => void deleteSegment(info.path)}
									className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
								>
									Delete
								</button>
							)}
							{/* The quiet inline confirmation — next to the action, not the old path-echoing line at the section's bottom (production-copy… */}
							{segmentStatus && (
								<p className="text-xs text-muted-foreground/70" data-testid="segment-status">
									{segmentStatus}
								</p>
							)}
						</div>
					</div>
				)}
			</div>
		);
	};



	return (
		<>
			<SettingsGroup label="Tools" testid="group-tools">
				{/* The prober's graph tools: FIRST row of the group — its subject is the map, its mechanism is agent capability… */}
				{(() => {
					const graphOn = graph?.enabled ?? true;
					return (
						<SettingsRow
							label="Graph tools"
							hint={graphOn ? "Lets the tutor consult your knowledge map between sessions" : "Graph is disabled"}
							testid="graph-tools-row"
							dimmed={!graphOn}
						>
							<Toggle
								checked={agent?.graphTools?.enabled ?? true}
								disabled={!graphOn}
								label="graph tools"
								onChange={(on) => onSectionChange(composeGraphTools(agent, on))}
							/>
						</SettingsRow>
					);
				})()}
				{/* The quizzing mechanic: segmented — exactly one of Multiple choice / Free recall is active… */}
				{(() => {
					const free = agent?.tools?.explain === true;
					return (
						<SettingsRow
							label="Quizzing"
							hint="How both tutors check your understanding"
							testid="quiz-mechanics-row"
						>
							<div
								role="radiogroup"
								aria-label="Quizzing mechanics"
								className="flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
								>
								{(["choice", "free"] as const).map((m) => {
									const active = m === "free" ? free : !free;
									return (
										<button
											key={m}
											type="button"
											role="radio"
											aria-checked={active}
											data-testid={`quiz-mechanics-${m}`}
											onClick={() => onSectionChange(composeQuizMechanics(agent, m))}
											className={cn(
												"h-8 rounded-md px-3 text-sm font-medium transition-colors",
												active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
											)}
										>
											{m === "choice" ? "Multiple choice" : "Free recall"}
										</button>
									);
								})}
							</div>
						</SettingsRow>
					);
				})()}
			</SettingsGroup>

			<SettingsGroup label="System prompts" testid="group-prompts">
				{prompts === null ? (
					<p className="text-xs text-muted-foreground/70">Loading prompt segments…</p>
				) : (
					<div className="flex flex-col gap-4">
						{/* The owner's ruled order: Teacher first, then Prober, then Shared LAST — shared chunks once (deduplicated), each section in prompt-assembly order. */}
						{sectionedSegments(prompts).map((section) => (
							<div key={section.id} data-testid={`prompt-section-${section.id}`}>
								<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">
									{section.label}
								</p>
								{section.hint && (
									<p className="mb-1 text-xs text-muted-foreground/60">{section.hint}</p>
								)}
								<div className="flex flex-col gap-2">
									{section.segments.map((info) => segmentRow(info))}
								</div>
							</div>
						))}
					</div>
				)}
			</SettingsGroup>
		</>
	);
}
