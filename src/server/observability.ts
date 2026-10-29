/** Server-side observability surface — the barrel-approved exports the transport layer (app/api/*) reads for background-process status. */

import { extractionStatuses, type ExtractionPhase } from "../agent/subagents/extraction.ts";
import { chatStore } from "../store/chats.ts";
import { graphRevision } from "./graph.ts";
import { listJobs } from "./jobs.ts";
import type { JobRecord } from "../core/contracts.ts";

export { abortExtraction, extractionStatuses } from "../agent/subagents/extraction.ts";
export { chatStore } from "../store/chats.ts";

/** A running sub-agent job, joined with its chat's title for the dock. */
interface ActivityJob extends JobRecord {
	costUsd: number | null;
	title: string;
	contextLimit: number | null;
}

/** One extraction-pipeline JOB (title joined), oldest first. */
interface ActivityExtraction {
	id: string;
	chatId: string;
	part?: { i: number; n: number };
	title: string;
	phase: ExtractionPhase;
	startedAt: number;
}

/** The dock's whole world in one payload: every running process, every view. */
/** The dock's whole world + the graph's version stamp: the payload carries graphRevision (max mtime across the graph data files */
export function activityFeed(): {
	jobs: ActivityJob[];
	extractions: ActivityExtraction[];
	graphRevision: number;
} {
	const chats = chatStore.listChats();
	const jobs: ActivityJob[] = [];
	for (const chat of chats) {
		for (const job of listJobs(chat.id)) {
			if (job.status === "running") {
				jobs.push({
					...job,
					costUsd: null,
					title: chat.title ?? chat.id,
					contextLimit: null,
				});
			}
		}
	}
	const extractions: ActivityExtraction[] = extractionStatuses().map((run) => ({
		id: run.part ? `${run.chatId}#${run.part.i}` : run.chatId,
		chatId: run.chatId,
		part: run.part,
		// The run's own label never reaches this feed (unlike the graph status route) — the chat store's title, or the bare id for notes sources
		title:
			(run.label ?? chatStore.getChat(run.chatId)?.title ?? run.chatId) +
			(run.part ? ` · ${run.part.i}/${run.part.n}` : ""),
		phase: run.phase,
		startedAt: run.startedAt,
	}));
	// oldest-first on last activity: the stable blob order (ISO strings sort chronologically)
	jobs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	return {
		jobs,
		extractions: extractions.sort((a, b) => a.startedAt - b.startedAt),
		graphRevision: graphRevision(),
	};
}
