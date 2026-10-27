"use client";

import type { ReactNode } from "react";
import type { TurnUsage } from "@/src/core";
import { formatTokens } from "@/components/usage-format";

export function formatContextMeasurement(tokens: number | null, limit: number | null): string {
	const numerator = tokens === null ? "?" : formatTokens(tokens);
	return limit === null ? numerator : `${numerator} / ${formatTokens(limit)}`;
}

/**
 * The below-composer bar: the composer's control row — the leading slot
 * (the home composer's teach | practice switch) and the dictation strip.
 * Under the Claude Code bridge (docs/claude-code-bridge.md) the app has no
 * model, cost or context of its own to show; the learner's Claude Code
 * owns those. The session-data props stay accepted so callers need not
 * change shape.
 */
export function StatsBar({
	dictationSlot,
	leadingSlot,
}: {
	turns?: TurnUsage[];
	contextTokens?: number | null;
	pricing?: unknown;
	chatId?: string;
	/** The dictation strip (STT wave, 2026-09-17): the mic button, whose meter
	 *  unfurls to fill the row while recording. */
	dictationSlot?: ReactNode;
	/** The row's LEFT edge (practice sessions, 2026-10-04): the home
	 *  composer's teach | practice switch. */
	leadingSlot?: ReactNode;
}) {
	return (
		<div
			data-testid="stats-bar"
			// pointer-events-auto: the sticky composer wrapper is pointer-events-none
			// (so its transparent gradient area never blocks scrolling) — this row
			// must re-enable events or every control on it is dead.
			className="pointer-events-auto relative flex items-center justify-between gap-3 px-3 pt-2 text-xs text-muted-foreground"
		>
			{leadingSlot}
			<div className="flex min-w-0 flex-1 items-center justify-end">{dictationSlot}</div>
		</div>
	);
}
