"use client";

import type { ReactNode } from "react";
import type { TurnUsage } from "@/src/core";


/** The below-composer bar: the composer's control row — the leading slot (the home composer's teach | practice switch) and the dictation strip. */
export function StatsBar({
	dictationSlot,
	leadingSlot,
}: {
	turns?: TurnUsage[];
	contextTokens?: number | null;
	pricing?: unknown;
	chatId?: string;
	/** The dictation strip: the mic button, whose meter unfurls to fill the row while recording. */
	dictationSlot?: ReactNode;
	/** The row's LEFT edge: the home composer's teach | practice switch. */
	leadingSlot?: ReactNode;
}) {
	return (
		<div
			data-testid="stats-bar"
			// pointer-events-auto: the sticky composer wrapper is pointer-events-none (so its transparent gradient area never blocks scrolling)
			className="pointer-events-auto relative flex items-center justify-between gap-3 px-3 pt-2 text-xs text-muted-foreground"
		>
			{leadingSlot}
			<div className="flex min-w-0 flex-1 items-center justify-end">{dictationSlot}</div>
		</div>
	);
}
