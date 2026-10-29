"use client";

import { ClipboardCheckIcon } from "lucide-react";
import { parseProbeDoneInput, type ProbeDoneResult } from "@/src/core";

/** The probe conclusion card (docs/probe-teach-split.md §2): renders the prober's probe_done call. */
export function ProbeDoneCard({ part }: { part: { input?: unknown; output?: unknown; state?: unknown } }) {
	const output = part.output as ProbeDoneResult | undefined;
	const state = typeof part.state === "string" ? part.state : "";

	// Parse, don't cast (the seam rule, src/core/tool-parts.ts): the model authored this input
	const input = parseProbeDoneInput(part.input);

	// The assessment is the CALL's input: the result's echo is gone — details is {ok:true} only, and the refusal branch below still reads output.error.
	const assessment = input?.assessment;
	const strands = assessment && Array.isArray(assessment.strands) ? assessment.strands : null;

	return (
		<div data-testid="probe-done-card" className="my-3 rounded-xl border bg-card/60 p-3">
			<div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<ClipboardCheckIcon className="size-3.5 text-primary" />
				Probe concluded — your assessment
			</div>
			{output && !output.ok ? (
				<p className="text-sm text-muted-foreground">The prober retried: {output.error}</p>
			) : state === "output-error" ? (
				<p className="text-sm text-muted-foreground">
					The assessment was malformed — the prober retried with a corrected one.
				</p>
			) : strands ? (
				<div className="space-y-2">
					{strands.map((s, i) => (
						<div key={i} className="rounded-lg bg-background/60 px-3 py-2">
							<div className="text-sm font-medium">{s.strand}</div>
							<div className="mt-0.5 text-sm text-muted-foreground">{s.assessment}</div>
						</div>
					))}
					{assessment?.summary && (
						<p className="px-1 text-sm text-muted-foreground">{assessment.summary}</p>
					)}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">Writing the assessment…</p>
			)}
		</div>
	);
}