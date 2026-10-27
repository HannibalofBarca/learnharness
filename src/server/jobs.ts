/**
 * Job records under the Claude Code bridge (docs/claude-code-bridge.md):
 * the tutor Claude does the research / pdf / demo / visual work itself and
 * delivers it finished (src/server/claude/deliver-tools.ts), so a job is
 * born done — there is no background runner, wake pipeline or steer queue.
 * What remains is the record list the job cards read, and an honest abort
 * answer for any legacy record still marked running.
 */

import type { JobRecord } from "../core/contracts.ts";
import { stores } from "./stores.ts";

export interface AbortOutcome {
	ok: boolean;
	reason?: "not_found" | "not_running";
}

/** Nothing runs in the background any more: a legacy "running" record is
 *  closed as aborted; anything else was never abortable. */
export function abortJob(jobId: string): AbortOutcome {
	const job = stores.jobStore.getJob(jobId);
	if (!job) return { ok: false, reason: "not_found" };
	if (job.status !== "running" || job.result) return { ok: false, reason: "not_running" };
	stores.jobStore.updateJob(jobId, { status: "error", error: "Aborted by learner", activity: "aborted" });
	return { ok: true };
}

/** The /api/jobs entry: job list for the client poll. */
export function listJobs(chatId: string): JobRecord[] {
	return stores.jobStore.listJobs(chatId);
}
