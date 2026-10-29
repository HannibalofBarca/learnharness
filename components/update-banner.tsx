"use client";

/** The auto-update banner. */

import { useUpdateState } from "@/components/settings/update-settings.tsx";

export default function UpdateBanner() {
	const { state: ready } = useUpdateState();
	if (ready?.status !== "downloaded") return null;
	return (
		<div
			data-testid="update-banner"
			className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
		>
			<div className="text-sm">
				<span className="font-medium">LearnHarness {ready.version ?? "update"} is ready</span>
				<span className="text-muted-foreground"> — restart to finish installing.</span>
			</div>
			<button
				type="button"
				onClick={() => window.lh?.installUpdate?.()}
				className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
			>
				Restart
			</button>
		</div>
	);
}
