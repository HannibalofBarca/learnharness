/** JobStore — the fs JSON adapter: one file per background sub-agent job in data/jobs/ (contracts.ts "THE ASYNC PROTOCOL"). */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { JobStore } from "../core/ports.ts";
import type { CreateJobInit, JobPatch } from "../core/ports.ts";
import type { JobRecord } from "../core/contracts.ts";

/** Background jobs (data/jobs). Not in config.ts PATHS (orchestrator-owned). */
const JOBS_DIR = path.join(PATHS.data, "jobs");

function jobFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
	return path.join(JOBS_DIR, `${id}.json`);
}

/** Writes announce on the events channel AFTER the write lands (the notify-after-write law, beginTurn precedent) */
function createJob(init: CreateJobInit): JobRecord {
	const now = new Date().toISOString();
	const record: JobRecord = {
		id: `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		kind: init.kind,
		chatId: init.chatId,
		toolCallId: init.toolCallId,
		...(init.input !== undefined ? { input: init.input } : {}),
		status: "running",
		activity: init.activity ?? "starting",
		createdAt: now,
		updatedAt: now,
	};
	fs.mkdirSync(JOBS_DIR, { recursive: true });
	fs.writeFileSync(jobFile(record.id), JSON.stringify(record, null, "\t"), "utf-8");
	emit("jobs-changed", { chatId: init.chatId });
	return record;
}

function getJob(id: string): JobRecord | null {
	try {
		return JSON.parse(fs.readFileSync(jobFile(id), "utf-8")) as JobRecord;
	} catch {
		return null;
	}
}

/** Merge a partial patch into the record (identity fields are immutable). */
function updateJob(id: string, patch: JobPatch): JobRecord | null {
	const record = getJob(id);
	if (!record) return null;
	const next: JobRecord = { ...record, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
	fs.writeFileSync(jobFile(id), JSON.stringify(next, null, "\t"), "utf-8");
	// EVERY write, not just status flips: progress-line updates must reach the dispatch cards (the view debounces the fetch bursts).
	emit("jobs-changed", { chatId: next.chatId });
	return next;
}

/** All jobs for a chat, newest activity first. */
function listJobs(chatId: string): JobRecord[] {
	try {
		fs.mkdirSync(JOBS_DIR, { recursive: true });
		return fs
			.readdirSync(JOBS_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getJob(f.slice(0, -5)))
			.filter((j): j is JobRecord => j !== null && j.chatId === chatId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
function findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null {
	return listJobs(chatId).find((j) => j.toolCallId === toolCallId) ?? null;
}

/** Delete every job record file for a chat — running or finished, they are the chat's records and die with it. */
function deleteJobsForChat(chatId: string): number {
	let removed = 0;
	for (const job of listJobs(chatId)) {
		try {
			fs.unlinkSync(jobFile(job.id));
			removed++;
		} catch {
			/* already gone — the count is best-effort truth */
		}
	}
	// Only when something actually died — a zero-file delete wrote nothing (the endTurn present-entry law).
	if (removed > 0) emit("jobs-changed", { chatId });
	return removed;
}

export const jobStore: JobStore = {
	createJob,
	getJob,
	updateJob,
	listJobs,
	findJobByToolCallId,
	deleteJobsForChat,
};
