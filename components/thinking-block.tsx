"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { cn } from "@/lib/utils";

/** The unified user-thinking row: ONE visual language for every surface where the learner's own thinking renders — practice thinking traces */

// ── The ⌘T store (module-scope, one per page load) ───────────────────────── null = "rows run their own defaults" (the pre-toggle state)
let allUserThinkingOpen: boolean | null = null;
const userThinkingListeners = new Set<(open: boolean) => void>();

export function currentUserThinkingOpen(): boolean {
	return allUserThinkingOpen ?? true;
}

/** The row's starting state: an explicit ⌘T set wins over the row's own default (late mounts honor the last set — same path as the live sync */
function resolveUserThinkingOpen(defaultOpen: boolean): boolean {
	return allUserThinkingOpen ?? defaultOpen;
}

export function setAllUserThinkingOpen(open: boolean) {
	allUserThinkingOpen = open;
	for (const l of userThinkingListeners) l(open);
}

function subscribeUserThinking(fn: (open: boolean) => void): () => void {
	userThinkingListeners.add(fn);
	if (allUserThinkingOpen !== null) fn(allUserThinkingOpen); // late mounts honor the last set
	return () => userThinkingListeners.delete(fn);
}

export function ThinkingBlock({
	label = "YOUR THINKING",
	text,
	testId,
	dataCommit,
	defaultOpen = false,
	inCard = false,
}: {
	label?: string;
	text: string;
	testId?: string;
	/** The practice marker's register flag (commit vs nudge). */
	dataCommit?: boolean;
	/** Transcript rows arrive expanded. */
	defaultOpen?: boolean;
	/** On the card's own background: no band (the accent read too light). */
	inCard?: boolean;
}) {
	const [open, setOpen] = useState(() => resolveUserThinkingOpen(defaultOpen));
	// ⌘T: an explicit global set overrides every row (once set, rows re-sync).
	const syncedRef = useRef(false);
	useEffect(
		() => subscribeUserThinking((o) => { syncedRef.current = true; setOpen(o); }),
		[],
	);
	return (
		/* The rail GROUPS and the rail IS THE MISSING CHARACTER: the heading sits INSIDE the rail */
		<div
			data-testid={testId}
			data-commit={dataCommit === undefined ? undefined : dataCommit ? "true" : "false"}
			className={cn(
				// Round five: total inset still 3ch (the chevron law); the rail narrows (14px gap), padding 4px, pr-4 keeps the text off the band's right edge.
				"lh-card-enter my-2 w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 py-1 pl-[14px] pr-4 font-ui text-xs",
				inCard ? "" : "bg-card",
			)}
		>
			<button
				type="button"
				data-testid={testId ? `${testId}-trigger` : undefined}
				onClick={(e) => {
					setOpen((v) => !v);
					blurAfterPointerClick(e);
				}}
				aria-expanded={open}
				className="flex w-full items-center gap-2 font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
			>
				{label}
				<ChevronDownIcon className={cn("size-4 shrink-0 transition-transform", open ? "rotate-180" : "rotate-0")} />
			</button>
			{open && (
				<span className="lh-prose mt-1.5 block whitespace-pre-wrap text-[15px] italic text-foreground/50">{text}</span>
			)}
		</div>
	);
}
