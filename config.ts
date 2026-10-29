import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** THE data-location seam: LH_DATA_DIR relocates every MUTABLE record — chat sessions, graph ledgers, the embedding model cache — when set. */
const DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.join(ROOT, "data");

/** Coding chats' workspaces: one folder per coding topic, outside the data dir (it is the learner's code, not app state). */
export const CODE_WORKSPACES = process.env.LH_CODE_WORKSPACES
	? path.resolve(process.env.LH_CODE_WORKSPACES)
	: path.join(os.homedir(), "source", "Harness Homework", "scripts");

export const PATHS = {
	root: ROOT,
	/** Teacher system prompt — the agent's instructions (src/agent/). */
	teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	data: DATA_ROOT,
	/** Chat sessions (AI SDK UIMessage transcripts, one JSON file per chat). */
	chats: path.join(DATA_ROOT, "chats"),
	graph: path.join(DATA_ROOT, "graph"),
	/** Debug artifacts (env-gated): data/debug/provider-events/<chatId>.jsonl raw provider stream recordings (src/agent/provider-events.ts). */
	debug: path.join(DATA_ROOT, "debug"),
} as const;


/** Every agent role in the app. */
export type ModelRole =
	| "prober"
	| "teacher"
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "pdfReader"
	| "extractor"
	| "auditor";

/** The LIVE graph store (src/store/graph.ts) — owned by the app's extraction pipeline. */
export const LEDGER_FILES = {
	nodes: path.join(PATHS.graph, "nodes.jsonl"),
	chains: path.join(PATHS.graph, "chains.jsonl"),
	sessions: path.join(PATHS.graph, "sessions.jsonl"),
	/** Per-message extraction coverage (contracts/graph.ts CoverageEntry; the checkpoint's replacement for chat extractions — notes keep sessions.jsonl */
	coverage: path.join(PATHS.graph, "coverage.jsonl"),
} as const;

/** Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource record (contracts/graph.ts) */
export const SOURCES_FILE = path.join(PATHS.graph, "sources.json");
/** The layout ledger (read-modify-write like sources.json): nodeId → {x,y} resting positions from the incremental settle (core/layout.ts). */
export const POSITIONS_FILE = path.join(PATHS.graph, "positions.json");

/** Graph render settings (the settings-panel controls): one small JSON blob, read-modify-write. */
export const RENDER_SETTINGS_FILE = path.join(PATHS.graph, "render-settings.json");

/** The graph-family FORMAT STAMP sidecar: one version for the whole family — the four JSONL ledgers, sources.json, render-settings.json. */
export const GRAPH_FORMAT_FILE = path.join(PATHS.graph, "format.json");

/** THE USER SETTINGS RECORD: one versioned, DELTA-shaped JSON blob at the data-dir seam holding every non-secret product preference — general */
export const SETTINGS_FILE = path.join(DATA_ROOT, "settings.json");

/** User prompt-override files: the per-segment system-prompt overrides mirroring the SOURCE layout (src/agent/prompts/) */
export const PROMPTS_OVERRIDE_DIR = path.join(DATA_ROOT, "prompts");

/** THE AUTH/KEY STORE: BYOK provider keys in a flat {VAR: value} JSON map — the SAME file the Electron app has always hand-edited. */
export const AUTH_FILE = process.env.LH_AUTH_FILE
	? path.resolve(process.env.LH_AUTH_FILE)
	: path.join(ROOT, "auth.json");
