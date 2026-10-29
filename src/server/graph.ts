import * as fs from "node:fs";
import { LEDGER_FILES, POSITIONS_FILE } from "../../config.ts";
import type { GraphSnapshot } from "../core/contracts.ts";
import { graphSnapshot } from "../core/graph.ts";
import {
	deleteNodeTraces,
	type NodeDeletionStats,
} from "../core/graph-deletion.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";

/** Server-side graph entry for the home view (GET /api/graph). */
export function graphView(): GraphSnapshot {
	return graphSnapshot(stores);
}

/** The graph's version stamp: the max mtime across every graph data file — ledgers, positions. */
export function graphRevision(): number {
	let revision = 0;
	for (const file of [
		LEDGER_FILES.nodes,
		LEDGER_FILES.chains,
		LEDGER_FILES.sessions,
		LEDGER_FILES.coverage,
		POSITIONS_FILE,
	]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	return revision;
}

// ─── single-node deletion ──────────

/** What deleteGraphNode did — the route maps it straight to HTTP. */
type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "extraction_running"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: number };

/** Delete one node by id — FULL DEATH (core/graph-deletion.ts for the ledger semantics). */
export function deleteGraphNode(nodeId: string): NodeDeleteOutcome {
	if (extractionStatuses().length > 0) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "An extraction is running — try again when it finishes",
		};
	}
	// THE SYNC BLOCK — no awaits below (the doc above): the gate and the rewrite are one atomic stretch of the event loop.
	const stats = deleteNodeTraces(stores.graphStore, nodeId);
	if (stats === null) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, stats, graphRevision: graphRevision() };
}

