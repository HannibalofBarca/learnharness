"use client";

import { useContext } from "react";
import { CheckIcon, SettingsIcon, XIcon } from "lucide-react";
import { JobsContext } from "@/components/jobs-context";
import { ChatActionsContext } from "@/components/chat";
import { isModelsRefusal, isProviderKeyRefusal, type JobKind, type JobRecord } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";

/** The dispatch card (contracts.ts "THE ASYNC PROTOCOL" §4): the tool-call box for a background sub-agent. */
const KIND_LABEL: Record<JobKind, string> = {
	research: "Research agent",
	demo: "Demo agent",
	visual: "Figure agent",
	pdf: "PDF reader",
};

export function DispatchCard({ toolCallId, kind }: { toolCallId: string; kind: JobKind }) {
	const jobs = useContext(JobsContext);
	const job = jobs.find((j) => j.toolCallId === toolCallId) ?? null;
	const label = KIND_LABEL[kind];

	if (!job || job.status === "running") {
		return <DispatchActivityCard job={job} label={label} />;
	}
	// BYOK: a job refused for missing models is INFO, not scary-error
	if (isModelsRefusal(job.error)) {
		return <DispatchRefusedCard label={label} line="needs model setup" button="Set up models" />;
	}
	if (isProviderKeyRefusal(job.error)) {
		return <DispatchRefusedCard label={label} line="needs a provider key" button="Add a key" />;
	}
	const failed = job.status === "error";
	return (
		<div
			className="flex items-center gap-2 text-xs text-muted-foreground"
			data-testid="dispatch-settled"
		>
			{failed ? <XIcon className="size-3.5 text-red-500" /> : <CheckIcon className="size-3.5" />}
			<span className="font-medium uppercase tracking-wide">{label}</span>
			<span>{failed ? "failed" : "finished"}</span>
		</div>
	);
}

/** The refused card: quiet info tone — nothing red, nothing "failed". */
function DispatchRefusedCard({ label, line, button }: { label: string; line: string; button: string }) {
	const ctx = useContext(ChatActionsContext);
	return (
		<div
			className="flex items-center gap-2 text-xs text-muted-foreground"
			data-testid="dispatch-refused"
		>
			<SettingsIcon className="size-3.5" />
			<span className="font-medium uppercase tracking-wide">{label}</span>
			<span>{line}</span>
			{ctx && (
				<button
					type="button"
					data-testid="dispatch-setup-link"
					onClick={ctx.openSetup}
					className="ml-1 rounded-sm border border-border bg-card px-2 py-0.5 font-ui normal-case tracking-normal text-foreground transition-colors hover:border-muted-foreground/50"
				>
					{button}
				</button>
			)}
		</div>
	);
}

function DispatchActivityCard({ job, label }: { job: JobRecord | null; label: string }) {
	// Elapsed from createdAt — jobs appear here only via the jobs feed (post-mount), so no SSR/hydration mismatch.
	const elapsed =
		job && job.createdAt ? Math.max(0, Math.round((Date.now() - Date.parse(job.createdAt)) / 1000)) : null;
	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground"
			data-testid="dispatch-card"
		>
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{/* The working-state grammar: the Braille spinner replaces the pulsing dot — one indicator everywhere. */}
				<BrailleSpinner label={`${label} running`} />
				{label}
				{elapsed !== null && <span className="font-normal">· {elapsed}s</span>}
			</div>
			{job?.activity && (
				<div className="mt-1 truncate text-sm text-muted-foreground" data-testid="dispatch-activity-line">
					{job.activity}
				</div>
			)}
			{!job && (
				<div className="mt-1 text-sm text-muted-foreground" data-testid="dispatch-pending">
					Dispatched…
				</div>
			)}
		</div>
	);
}
