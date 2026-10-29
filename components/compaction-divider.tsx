"use client";

import type { CompactionDetails } from "@/src/core";

/** What one divider carries: the marker's full model-facing content (the [SESSION HISTORY COMPACTED] header + the summary) and its details. */
export interface CompactionDividerData {
	content: string;
	details: CompactionDetails;
}

/** The moment divider: minimal centered small text where the user currently is — the retrying-message register (SystemLine's exact classes) */
export function CompactionMomentDivider({ data: _data }: { data: CompactionDividerData }) {
	return (
		<div className="flex w-full items-center justify-center py-1">
			<span data-testid="compaction-divider" className="px-1.5 text-xs text-muted-foreground/70">
				Context compacted
			</span>
		</div>
	);
}

/** The cut divider: the LONGER divider at the actual compaction cut — the seam where verbatim history ends and the kept recent tail begins. */
export function CompactionCutDivider({ data }: { data: CompactionDividerData }) {
	const kTok = data.details.tokensBefore > 0 ? ` · ${Math.round(data.details.tokensBefore / 1000)}k tok` : "";
	return (
		<div data-testid="compaction-cut-divider" className="my-4 flex w-full items-center gap-3">
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
			<span className="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				History compacted{kTok}
			</span>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
		</div>
	);
}
