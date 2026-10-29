import type { Phase3 } from "@/src/core";

/** The in-session phase presentation: the header chip next to the session title */

/** Header-chip labels: the phases as the learner thinks of them. */
const CHIP_LABEL: Record<Phase3, string> = {
	probe: "Probing",
	plan: "Planning",
	teach: "Teaching",
};

/** The header label: the phase as a quiet flat tag: no border, no pill chrome, no padding */
export function PhaseChip({ phase }: { phase: Phase3 }) {
	return (
		<span
			data-testid="phase-chip"
			data-phase={phase}
			aria-hidden="true"
			className="pointer-events-none flex shrink-0 select-none items-center text-xs font-medium uppercase tracking-wide text-muted-foreground"
		>
			{CHIP_LABEL[phase]}
		</span>
	);
}

/** The transcript boundary: a monochrome dotted rule at the message where the session enters `phase`. */
export function PhaseDivider({ phase, nodeCount }: { phase: Phase3; nodeCount?: number }) {
	if (phase === "probe") return null;
	const label =
		phase === "plan" && nodeCount
			? `Plan · ${nodeCount} node${nodeCount === 1 ? "" : "s"}`
			: CHIP_LABEL[phase];
	return (
		<div className="my-4 flex w-full items-center gap-3" data-testid={`phase-divider-${phase}`}>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
			<span className="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</span>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
		</div>
	);
}

