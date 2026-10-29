import { abortExtraction, extractionStatuses } from "../agent/subagents/extraction.ts";
import { dropClaudeSession } from "./claude/session.ts";
import { coverageOf } from "../core/coverage.ts";
import { deleteChatTraces, type ChatDeleteMode, type ChatDeletionStats } from "../core/graph-deletion.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { clearTurnFailure } from "./turn-runs.ts";

/** Server-side chat entries for the transport layer (app/api/chats*, app/chat/[id]). */

export const { createChat, getChat, listChats } = stores.chatStore;
export { titleFromPrompt };
export type { ChatDeleteMode } from "../core/graph-deletion.ts";

/** How long the wind-down wait may take before the caller gets a retryable 503 (an aborted extraction ends at its next model-call boundary */
const WIND_DOWN_TIMEOUT_MS = 10_000;
const WIND_DOWN_POLL_MS = 50;

/** What deleteChatSession did — the route maps it straight to HTTP. */
type ChatDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "jobs_running"; error: string; jobIds: string[] }
	| { ok: false; status: 503; code: "extraction_winding_down"; error: string }
	| {
			ok: true;
			mode: ChatDeleteMode;
			stats: ChatDeletionStats;
			jobsRemoved: number;
			graphRevision: number;
	  };

/** Delete a session: gates first, then the purge. */
function runningWorkBlocker(chatId: string): Extract<ChatDeleteOutcome, { status: 409 }> | null {
	if (isTurnRunning(chatId)) {
		return {
			ok: false,
			status: 409,
			code: "turn_in_flight",
			error: "A turn is running in this session — try again when it finishes",
			jobIds: [],
		};
	}
	// Legacy records kept completed workers running until delivery.
	const runningJobs = stores.jobStore.listJobs(chatId).filter((job) =>
		job.status === "running" && !job.result);
	if (runningJobs.length > 0) {
		return {
			ok: false,
			status: 409,
			code: "jobs_running",
			error: "Background jobs are still running in this session — try again when they finish",
			jobIds: runningJobs.map((job) => job.id),
		};
	}
	return null;
}

export async function deleteChatSession(chatId: string, mode: ChatDeleteMode): Promise<ChatDeleteOutcome> {
	if (!stores.chatStore.getChat(chatId)) {
		return { ok: false, status: 404, code: "not_found", error: "No such session" };
	}
	const blocker = runningWorkBlocker(chatId);
	if (blocker) return blocker;
	if (extractionStatuses().some((run) => run.chatId === chatId)) {
		abortExtraction(chatId); // true cancellation — spend stops, nothing merges
		const deadline = Date.now() + WIND_DOWN_TIMEOUT_MS;
		while (extractionStatuses().some((run) => run.chatId === chatId)) {
			if (Date.now() > deadline) {
				return {
					ok: false,
					status: 503,
					code: "extraction_winding_down",
					error: "The session's extraction is still winding down — try again in a moment",
				};
			}
			await new Promise((resolve) => setTimeout(resolve, WIND_DOWN_POLL_MS));
		}
	}

	// A result wake or a worker may have started during extraction wind-down.
	const lateBlocker = runningWorkBlocker(chatId);
	if (lateBlocker) return lateBlocker;

	// THE SYNC BLOCK — no awaits below (see the doc comment).
	const stats = deleteChatTraces(stores.graphStore, chatId, mode);
	const jobsRemoved = stores.jobStore.deleteJobsForChat(chatId);
	if (stores.chatStore.deleteChat(chatId)) {
		clearTurnFailure(chatId);
		dropClaudeSession(chatId);
	}
	return { ok: true, mode, stats, jobsRemoved, graphRevision: graphRevision() };
}

/** One session's coverage read: the chat view's ring meter + popover data, scoped to one chat (the all-sessions GET died with this redesign */
interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	/** True while a chat-kind extraction run is registered for this session. */
	running: boolean;
	/** ISO of the newest fold in this session's coverage rows; null before any. */
	lastFoldedAt: string | null;
}

/** The per-session coverage block (see SessionCoverage). */
export function sessionCoverage(chatId: string): SessionCoverage | null {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return null;
	const entries = stores.graphStore.readCoverage();
	// Wave B: the record is native history — coverage reads through the projection (same view the extraction pipeline folds).
	const cov = coverageOf(record.messages, entries, chatId);
	let lastFoldedAt: string | null = null;
	for (const entry of entries) {
		if (entry.chatId !== chatId) continue;
		if (lastFoldedAt === null || entry.foldedAt > lastFoldedAt) lastFoldedAt = entry.foldedAt;
	}
	return {
		totalMessages: cov.slots.length,
		coveredCount: cov.coveredCount,
		uncoveredCount: cov.uncoveredCount,
		coveredTokens: cov.coveredTokens,
		uncoveredTokens: cov.uncoveredTokens,
		running: extractionStatuses().some((run) => run.kind === "chat" && run.chatId === chatId),
		lastFoldedAt,
	};
}
