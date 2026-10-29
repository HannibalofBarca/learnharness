"use client";

import { useCallback } from "react";
import { joinDictation, useDictationTarget } from "@/components/dictation";

/** The reading-thinking field: a quiet textarea for thinking WHILE READING the teaching prose */
export function ReadingThinkingField({
	value,
	onChange,
	onEscape,
	onOpen,
	claim,
}: {
	value: string;
	onChange: (v: string) => void;
	/** Esc in the field stops dictation (threaded from the page's hook). */
	onEscape?: () => void;
	/** The check waits CLOSED — Enter opens it. */
	onOpen?: () => void;
	/** Primary dictation claim — true while the check is behind its reveal. */
	claim: boolean;
}) {
	useDictationTarget(
		useCallback(
			(t: string) => {
				onChange(joinDictation(value, t));
			},
			[value, onChange],
		),
		claim,
	);
	return (
		<div
			data-testid="reading-thinking-field"
			className="pointer-events-auto mb-2 rounded-2xl border bg-card/60 px-3 py-2 transition-colors focus-within:border-primary/50"
		>
			<div className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Thinking while reading
			</div>
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				/* py-0.5: the scrollbar fix. */
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						// Esc stops dictation (the strip's rule) — claimed so the window chain doesn't also read it as abort-turn.
						e.preventDefault();
						e.stopPropagation();
						onEscape?.();
						return;
					}
					// ENTER OPENS THE WAITING CHECK: while the check sits closed, plain Enter (and the universal ⌘/Ctrl+Enter) opens it
					if (e.key === "Enter" && onOpen !== undefined && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.stopPropagation();
						onOpen();
						return;
					}
					// The dock's dumping convention: plain Enter is a newline.
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.currentTarget.blur();
					}
				}}
				placeholder="Whatever comes to mind as you read."
				rows={1}
				className="field-sizing-content lh-input max-h-40 w-full resize-none bg-transparent py-0.5 outline-none placeholder:text-muted-foreground/70"
			/>
		</div>
	);
}
