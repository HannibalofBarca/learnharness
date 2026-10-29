/** Knowledge-graph contracts — nodes, ledgers, extraction findings The minimal implementation of the graph vision: every node is a TRUE proposition */
// ─── Knowledge graph (vision §1 — global, cross-session) ────────────────────

import type { ExtractionRunUsage } from "./chat.ts";

/** One relation of the DERIVED view — chains are the stored truth, and the snapshot derives UNTYPED arrows from them */
export interface GraphEdge {
	from: string;
	to: string;
}

/** One stored REASONING CHAIN — an argument: premises that JOINTLY entail the conclusion. */
export interface GraphChain {
	/** "arg_" + nanoid-like (store-assigned, the node-minting pattern). */
	id: string;
	/** Node ids of the argument's premises — at least one, jointly sufficient. */
	premises: string[];
	/** The node id the premises jointly imply. */
	conclusion: string;
	/** Every (chat, message) point where this argument was asserted — unioned across assertion lines at read time. */
	provenance: ProvenancePoint[];
	createdAt: string;
}

/** What one extraction run merged into the graph ledgers — the merger's output, also persisted in extraction-run usage records (contracts/chat). */
export interface EmissionStats {
	/** New graph nodes appended. */
	nodes: number;
	/** New reasoning chains appended. */
	chains?: number;
	/** Chains the simplification pass removed in this merge. */
	droppedChains?: number;
}

/** One provenance point — message-granular: nodes and edges record every (chat, message) where they came up, deep-linkable to the exact transcript point. */
export interface ProvenancePoint {
	/** The chat this point anchors to — or a notes source id ("src_…"): imports carry no message anchors (provenance is the file itself */
	chatId: string;
	messageId: string;
}

/** One imported notes file — the format-agnostic front door's bookkeeping */
export interface NotesSource {
	id: string;
	filePath: string;
	/** ISO — when this file was imported (the checkpoint's foldedAt). */
	importedAt: string;
	/** Legacy content fingerprint. */
	contentFp?: string;
	/** The run's usage log — same append-only discipline as ChatRecord.extractions, idempotent per startedAt. */
	extractions?: ExtractionRunUsage[];
}


/** The graph-family format version this build writes and understands (the format.json sidecar — src/store/graph-format.ts). */
export const CURRENT_GRAPH_FORMAT_VERSION = 1;


export interface GraphNode {
	/** Opaque stable id, store-assigned: "n_" + nanoid-like. */
	id: string;
	/** A very short label for the node — a compact handle like a glossary headword ("Will to power", "Divine command theory") */
	name: string;
	/** The minimal proposition — one true, self-contained statement, at full precision. */
	statement: string;
	/** Verbatim phrasings sessions used for this proposition (the identity audit trail — how the world said what the node says). */
	aliases: string[];
	createdAt: string;
	/** Every (chat, message) point where this proposition came up. */
	provenance: ProvenancePoint[];
}

/** sessions.jsonl line — the emission checkpoint for one chat (which chats have been folded, and through which updatedAt — never fold twice). */
export interface SessionCheckpoint {
	chatId: string;
	/** The chat record's `updatedAt` at the time of the fold. */
	foldedAt: string;
}

/** coverage.jsonl line: ONE MESSAGE of one chat has been extracted — by content fingerprint over exactly what the extraction view sees. */
export interface CoverageEntry {
	chatId: string;
	/** sha256 of the message's view lines — "covered" means exactly this. */
	fp: string;
	/** chars/4 estimate of the message's view — display + budgeting. */
	tokens: number;
	/** ISO — when this message's last extraction run merged. */
	foldedAt: string;
}

/** Store format (src/store/graph.ts): JSONL ledgers at config.LEDGER_FILES (nodes/chains/sessions), all append-only. */

// ─── Extraction findings (extractor output → audit → merger input) ───────────

/** One proposed proposition — a node candidate (or a re-encounter of one). */
export interface ExtractedProposition {
	/** Extractor-local id ("p1", …) referenced by edges. */
	id: string;
	/** A very short label — a few words, a compact handle like a glossary headword. */
	name: string;
	/** The minimal proposition — a true, self-contained, world-facing statement, at full precision. */
	statement: string;
	/** Verbatim phrasings the session used. */
	aliases: string[];
	/* Submit-schema slim: `messages` and `evidence` are GONE. */
	/** OPTIONAL, SESSION PATH ONLY: the message id of the ONE teacher passage this proposition came from */
	messageId?: string;
}

/** One proposed argument. */
export interface ExtractedChain {
	/** Proposition ids that JOINTLY entail the conclusion. */
	premises: string[];
	/** The proposition id the premises jointly imply. */
	conclusion: string;
}

/** The extractor's output shape: the raw reasoning chains. */
export interface SessionFindings {
	propositions: ExtractedProposition[];
	chains: ExtractedChain[];
}

/** One identity verdict: the extractor's local proposition id → the EXISTING graph node that proposition IS. */
export interface IdentityLink {
	id: string;
	linkTo: string;
}

/** The auditor's output — VERDICTS ONLY: the auditor never alters the extractor's findings, so it does not restate them */
export interface AuditVerdicts {
	links: IdentityLink[];
}

/** The GET /api/graph payload — everything the home view's PURE renderer needs. */

/** One rendered cluster in the snapshot payload (vision §1). */
export interface Cluster {
	/** The labeling record id when claimed; unlabeled clusters still appear (hull, no name) with a member-hash id. */
	id: string;
	/** null until the naming call has minted/claimed a labeling. */
	label: string | null;
	/** Node ids, sorted. Hull + centroid are renderer concerns. */
	members: string[];
}

export interface GraphSnapshot {
	/** Proposition nodes + the DERIVED implication nodes (one per chain, id = chain id) — what the canvas renders. */
	nodes: GraphNode[];
	/** The STORED proposition nodes alone (no derived implication nodes) — the stored truth, like `chains` */
	propositions: GraphNode[];
	/** DERIVED untyped arrows: premise → imp → conclusion. */
	edges: GraphEdge[];
	/** DERIVED LOGICAL arrows: every chain contracted to direct premise→ conclusion over PROPOSITION ids only (the imp hop collapsed). */
	logicalEdges: GraphEdge[];
	/** DERIVED imp linkage (one per MULTI-premise live chain) */
	impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
	/** The STORED reasoning chains (merged by (premises, conclusion) at read): the chain table's and the practice pipeline's input — they read the truth */
	chains: GraphChain[];
	/** chatId → title, for every chat that touched the graph. */
	sessions: Record<string, string>;
	/** srcId → file path, for every IMPORTED NOTES file that touched the graph (the format-agnostic front door): a static provenance entry */
	fileSources: Record<string, string>;
	/** nodeId → chatIds that touched the node (click-through provenance). */
	nodeSessions: Record<string, string[]>;
	/** Birth-session communities (core/session-clusters.ts: each proposition joins the cluster of the session that birthed it — session provenance */
	clusters: Cluster[];
	/** Resting layout positions per node id, when a positions ledger exists (core/layout.ts settle writes it). */
	positions?: Record<string, Position>;
}

/** A node's resting position in layout space (the positions ledger). */
export interface Position {
	x: number;
	y: number;
}

/** The auto-title's character cap: long enough to stay informative in the sidebar and the top bar */
const TITLE_MAX_CHARS = 72;

/** Derive a short chat title from the learner's first message (pure). */
export function titleFromPrompt(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	if (oneLine.length <= TITLE_MAX_CHARS) return oneLine;
	// Last space among the first TITLE_MAX_CHARS characters; the cut sits before it so no trailing space rides into the title.
	let cut = -1;
	for (let i = TITLE_MAX_CHARS; i > 0; i--) {
		if (oneLine[i - 1] === " ") {
			cut = i - 1;
			break;
		}
	}
	// One long word: no boundary exists under the cap — split it.
	if (cut < 0) cut = TITLE_MAX_CHARS;
	return `${oneLine.slice(0, cut)}…`;
}
