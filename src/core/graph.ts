/** The knowledge graph: merger (the deterministic final stage of the extraction pipeline — vision §1 construction) + derivation (reads). */

import { randomBytes } from "node:crypto";
import type { CoverageEntry,
} from "./contracts/graph.ts";
import type {
	AuditVerdicts,
	ExtractedChain,
	GraphChain,
	SessionFindings,
	Cluster,
	EmissionStats,
	GraphEdge,
	GraphNode,
	ProvenancePoint,
	GraphSnapshot,
} from "./contracts.ts";
import { MIN_CLUSTER_SIZE } from "./clusters.ts";
import { formatChainLine } from "./chains.ts";
import { attachImpToCommunities, birthSessionOf, birthSessionPartition } from "./session-clusters.ts";
import type { ChatStore, GraphStore } from "./ports.ts";

/** The storage ports every graph operation needs, passed explicitly. */
export interface GraphDeps {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

/** "n_" + 12 hex chars (contracts.ts GraphNode.id — store-assigned). */
function newGraphNodeId(): string {
	return `n_${randomBytes(6).toString("hex")}`;
}

/** "arg_" + 12 hex chars — the implication-node namespace (a chain's id IS its derived node's id; collision-free with n_ by construction). */
function newGraphChainId(): string {
	return `arg_${randomBytes(6).toString("hex")}`;
}

/** A chain's merge key: sorted premises + conclusion — the identity an assertion re-stating the same argument merges under. */
function chainKey(premises: ReadonlyArray<string>, conclusion: string): string {
	return `${[...premises].sort().join("+")}>${conclusion}`;
}

/** What one merge run merges FROM (the caller supplies it — the merger never reads the chat store): the coverage checkpoint for a session batch, or */
interface MergeSource {
	foldedAt: string;
	/** The batch being merged (chat path): one entry per message in the extracted batch */
	coverage?: CoverageEntry[];
}

/** The run's provenance point. */
function pointOf(chatId: string, messageId?: string): ProvenancePoint[] {
	return [{ chatId, messageId: messageId ?? "" }];
}

const samePoint = (a: ProvenancePoint, b: ProvenancePoint): boolean =>
	a.chatId === b.chatId && a.messageId === b.messageId;

// ─── the merger (extraction pipeline stage 3 — deterministic) ────────────────

/** Merge one job's audited findings into the graph ledgers — the pipeline's apply stage. */
export function mergeFindings(
	chatId: string,
	findings: SessionFindings,
	verdicts: AuditVerdicts,
	deps: GraphDeps,
	source: MergeSource,
): EmissionStats {
	const { graphStore: ledgers } = deps;
	const stats: EmissionStats = { nodes: 0, chains: 0 };

	// 1.
	const existingIds = new Set(ledgers.readNodes().map((n) => n.id));
	const mapping = new Map<string, string>();
	const now = new Date().toISOString();
	const linkOf = new Map(verdicts.links.map((l) => [l.id, l.linkTo]));

	// VERDICTS-ONLY: the propositions come from the extractor's findings verbatim; the auditor's links join here by id.
	for (const p of findings.propositions) {
		if (mapping.has(p.id)) continue; // duplicate id WITHIN this submit — first resolution stands
		// The anchor: a session proposition may carry its passage's messageId
		const points = pointOf(chatId, p.messageId);
		const linkTo = linkOf.get(p.id);
		let graphNodeId: string;
		if (linkTo !== undefined && existingIds.has(linkTo)) {
			// Identity verdict: this proposition IS that node.
			graphNodeId = linkTo;
			// Link-append: phrasings + provenance join at read time (the first line's name/statement/createdAt stand).
			ledgers.appendNode({
				id: graphNodeId,
				name: p.name,
				statement: p.statement,
				aliases: [...p.aliases],
				createdAt: now,
				provenance: points,
			});
		} else {
			const node: GraphNode = {
				id: newGraphNodeId(),
				name: p.name,
				statement: p.statement,
				aliases: [...p.aliases],
				createdAt: now,
				provenance: points,
			};
			ledgers.appendNode(node);
			stats.nodes++;
			graphNodeId = node.id;
			existingIds.add(graphNodeId);
		}
		mapping.set(p.id, graphNodeId);
	}

	// 2.
	const assertedByChat = new Set<string>();
	const idOfKey = new Map<string, string>();
	for (const line of ledgers.readChains()) {
		const key = chainKey(line.premises, line.conclusion);
		if (!idOfKey.has(key)) idOfKey.set(key, line.id);
		if (line.provenance.some((pt) => pt.chatId === chatId)) assertedByChat.add(key);
	}
	const emitChain = (chain: ExtractedChain): void => {
		// Mixed namespace: an endpoint resolves through the job-local map (this submit's propositions) OR passes through verbatim when it names an existing
		const resolve = (endpoint: string): string | undefined =>
			mapping.get(endpoint) ?? (existingIds.has(endpoint) ? endpoint : undefined);
		const conclusion = resolve(chain.conclusion);
		if (conclusion === undefined) return; // unresolvable endpoint — skip
		// Duplicate local ids resolving to one node (two phrasings of one premise) collapse; a premise equal to the conclusion is dropped.
		const premises = [...new Set(chain.premises.map(resolve))].filter(
			(p): p is string => p !== undefined && p !== conclusion,
		);
		if (premises.length === 0) return; // a chain IS an argument — bare propositions ride the node ledger alone
		const key = chainKey(premises, conclusion);
		if (assertedByChat.has(key)) return; // this chat already asserted this argument
		const id = idOfKey.get(key) ?? newGraphChainId();
		ledgers.appendChain({ id, premises, conclusion, createdAt: now, provenance: pointOf(chatId) });
		idOfKey.set(key, id);
		assertedByChat.add(key);
		stats.chains!++;
	};
	for (const chain of findings.chains) emitChain(chain); // the extractor's chains — the one chain source

	// 2b.
	const allChains = ledgers.readChains();
	const keptChains = simplifyChains(allChains);
	if (keptChains.length !== allChains.length) {
		ledgers.rewriteLedgers({ chains: keptChains });
		stats.droppedChains = allChains.length - keptChains.length;
	}

	// 3.
	if (source.coverage !== undefined) {
		for (const entry of source.coverage) ledgers.appendCoverage(entry);
	} else {
		ledgers.appendCheckpoint({ chatId, foldedAt: source.foldedAt });
	}
	return stats;
}

/** The deterministic chain-simplification pass: strips redundant derivations */
function simplifyChains(lines: GraphChain[]): GraphChain[] {
	if (lines.length < 2) return lines;

	// Group lines by chain key (logical chains).
	const groups = new Map<string, GraphChain[]>();
	for (const line of lines) {
		const key = chainKey(line.premises, line.conclusion);
		const bucket = groups.get(key);
		if (bucket === undefined) groups.set(key, [line]);
		else bucket.push(line);
	}

	// Ancestry over the FULL chain set: every node id reachable as a premise behind an id (A⟹X makes A an ancestor of X
	const premisesOf = new Map<string, string[][]>();
	for (const line of lines) {
		const bucket = premisesOf.get(line.conclusion);
		if (bucket === undefined) premisesOf.set(line.conclusion, [line.premises]);
		else bucket.push(line.premises);
	}
	const ancestryMemo = new Map<string, Set<string>>();
	const ancestry = (id: string, visiting: Set<string>): Set<string> => {
		const memo = ancestryMemo.get(id);
		if (memo !== undefined) return memo;
		const out = new Set<string>();
		if (visiting.has(id)) return out;
		visiting.add(id);
		for (const premises of premisesOf.get(id) ?? []) {
			for (const premise of premises) {
				out.add(premise);
				for (const ancestor of ancestry(premise, visiting)) out.add(ancestor);
			}
		}
		visiting.delete(id);
		ancestryMemo.set(id, out);
		return out;
	};

	// Per conclusion: greedy in (premiseCount, createdAt, key).
	const byConclusion = new Map<
		string,
		Array<{ key: string; premises: string[]; createdAt: string }>
	>();
	for (const [key, bucket] of groups) {
		const head = bucket[0]!; // the representative — its premises stand
		const entry = { key, premises: head.premises, createdAt: head.createdAt };
		const list = byConclusion.get(head.conclusion);
		if (list === undefined) byConclusion.set(head.conclusion, [entry]);
		else list.push(entry);
	}
	const droppedKeys = new Set<string>();
	for (const candidates of byConclusion.values()) {
		candidates.sort(
				(a, b) =>
					a.premises.length - b.premises.length ||
					a.createdAt.localeCompare(b.createdAt) ||
					a.key.localeCompare(b.key),
		);
		const kept: typeof candidates = [];
		for (const candidate of candidates) {
			const candidateSet = new Set(candidate.premises);
			const redundant = kept.some((k) => {
					// Rule 1 — prefer-fewest-premises: strict subset (equal keys are grouped, so a kept ⊆ candidate with fewer premises is strict).
					if (k.premises.every((p) => candidateSet.has(p))) return true;
					// Rule 2 — ancestry-cover: every candidate premise is a kept premise, or reachable behind one.
					const covered = new Set(k.premises);
					for (const p of k.premises) {
						for (const ancestor of ancestry(p, new Set())) covered.add(ancestor);
					}
					return candidate.premises.every((p) => covered.has(p));
			});
			if (redundant) droppedKeys.add(candidate.key);
			else kept.push(candidate);
		}
	}
	if (droppedKeys.size === 0) return lines;
	return lines.filter((line) => !droppedKeys.has(chainKey(line.premises, line.conclusion)));
}

// ─── derivation (reads only — everything below is recomputable) ─────────────

/** The merged STORED truth: propositions + chains. */
export interface DerivedGraph {
	nodes: GraphNode[];
	chains: GraphChain[];
}

/** The whole graph from the ledgers. */
export function getGraph(graphStore: Pick<GraphStore, "readNodes" | "readChains">): DerivedGraph {
	// Merge node lines by id (first line defines; later lines add phrasings).
	const byId = new Map<string, GraphNode>();
	for (const line of graphStore.readNodes()) {
		const existing = byId.get(line.id);
		if (!existing) {
			byId.set(line.id, { ...line, aliases: [...line.aliases], provenance: [...line.provenance] });
			continue;
		}
		// A later line's statement is a phrasing, not a replacement.
		for (const phrasing of [line.statement, ...line.aliases]) {
			if (phrasing.length > 0 && !existing.aliases.includes(phrasing)) existing.aliases.push(phrasing);
		}
		for (const pt of line.provenance) {
			if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
		}
	}

	// Merge chain assertion lines by (premises, conclusion): the first line's id/premises/createdAt stand, provenance unions.
	const chains: GraphChain[] = [];
	const byKey = new Map<string, GraphChain>();
	for (const line of graphStore.readChains()) {
		const key = chainKey(line.premises, line.conclusion);
		const existing = byKey.get(key);
		if (existing) {
			for (const pt of line.provenance) {
				if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
			}
		} else {
			const chain: GraphChain = { ...line, premises: [...line.premises], provenance: [...line.provenance] };
			byKey.set(key, chain);
			chains.push(chain);
		}
	}
	return { nodes: [...byId.values()], chains };
}

/** The DERIVED view — what the canvas renders. */
export function deriveView(graph: DerivedGraph): {
	nodes: GraphNode[];
	edges: GraphEdge[];
	logicalEdges: GraphEdge[];
	impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
} {
	const names: Record<string, { name: string }> = {};
	for (const node of graph.nodes) names[node.id] = { name: node.name };
	const live = new Set(graph.nodes.map((node) => node.id));
	const impNodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	// The LOGICAL edge set: every chain contracted to direct premise→conclusion arrows over PROPOSITION ids only
	const impLinks: Array<{ id: string; premises: string[]; conclusion: string }> = [];
	const logicalEdges: GraphEdge[] = [];
	const logicalSeen = new Set<string>();
	const emitLogical = (from: string, to: string): void => {
		const key = from + "\u0000" + to;
		if (logicalSeen.has(key)) return;
		logicalSeen.add(key);
		logicalEdges.push({ from, to });
	};
	for (const chain of graph.chains) {
		if (!live.has(chain.conclusion) || !chain.premises.every((premise) => live.has(premise))) continue;
		for (const premise of chain.premises) emitLogical(premise, chain.conclusion);
		// Single premise: the argument IS a plain arrow — no geometry point needed.
		if (chain.premises.length === 1) {
			edges.push({ from: chain.premises[0]!, to: chain.conclusion });
			continue;
		}
		impNodes.push({
			id: chain.id,
			name: "⟹",
			statement: formatChainLine(chain, names),
			aliases: [],
			createdAt: chain.createdAt,
			provenance: [...chain.provenance],
		});
		// The junction's linkage — what the depth pass needs for the midpoint anchor.
		impLinks.push({ id: chain.id, premises: [...chain.premises], conclusion: chain.conclusion });
		for (const premise of chain.premises) edges.push({ from: premise, to: chain.id });
		edges.push({ from: chain.id, to: chain.conclusion });
	}
	return { nodes: [...graph.nodes, ...impNodes], edges, logicalEdges, impLinks };
}

// ─── the /api/graph payload ──────────────────────────────────────────────────

/** Everything the home graph view needs, in one fetch (shape: contracts). */
export function graphSnapshot(deps: GraphDeps): GraphSnapshot {
	const graph = getGraph(deps.graphStore);
	// The canvas-facing lossy image: propositions + derived implication nodes, untyped arrows.
	const view = deriveView(graph);
	const nodes = view.nodes;

	const nodeChats = new Map<string, Set<string>>();
	const touch = (nodeId: string, chatId: string): void => {
		let chats = nodeChats.get(nodeId);
		if (!chats) {
			chats = new Set();
			nodeChats.set(nodeId, chats);
		}
		chats.add(chatId);
	};
	for (const node of nodes) {
		for (const pt of node.provenance) touch(node.id, pt.chatId);
	}
	// Labels for every source the graph can point back at: real chats (title, deep-linkable) and imported notes files (path, static
	const sourceIds = new Set<string>();
	for (const chats of nodeChats.values()) {
		for (const id of chats) sourceIds.add(id);
	}
	const sessions: Record<string, string> = {};
	const fileSources: Record<string, string> = {};
	for (const id of sourceIds) {
		const chat = deps.chatStore.getChat(id);
		if (chat) {
			sessions[id] = chat.title;
			continue;
		}
		const source = deps.graphStore.readSources().find((s) => s.id === id);
		if (source) fileSources[id] = source.filePath;
	}

	const nodeSessions: Record<string, string[]> = {};
	for (const [nodeId, chats] of nodeChats) {
		const ids = [...chats].filter((id) => sessions[id] !== undefined || fileSources[id] !== undefined);
		if (ids.length > 0) nodeSessions[nodeId] = ids;
	}

	// BIRTH-SESSION CLUSTERS: embeddings are dead — a cluster is the SESSION THAT CREATED ITS PROPOSITIONS
	const communities = birthSessionPartition(graph.nodes);
	const clusters: Cluster[] = communities
		.filter((community) => community.members.length >= MIN_CLUSTER_SIZE)
		.map((community) => ({
			id: community.id,
			label: sessions[community.id] ?? fileSources[community.id] ?? null,
			members: community.members,
		}));
	// IMP-NODE CLUSTER ASSIGNMENT: majority among the premises' birth sessions, ties to the chain's own birth
	attachImpToCommunities(clusters, graph.nodes, graph.chains);

	// Resting layout (Option A): the positions ledger, when the settle has ever run.
	const positions = deps.graphStore.readPositions();

	return {
		nodes,
		propositions: graph.nodes,
		edges: view.edges,
		logicalEdges: view.logicalEdges,
		impLinks: view.impLinks,
		chains: graph.chains,
		sessions,
		fileSources,
		nodeSessions,
		clusters,
		...(Object.keys(positions).length > 0 ? { positions } : {}),
	};
}

// ─── Prober graph tools — the data seam ───

/** One session in the prober's graph view: every provenance anchor the graph can name — a real chat (deep-linkable) or an imported notes file. */
interface GraphSessionEntry {
	/** chatId or notes source id ("src_…") — the birth-session key. */
	id: string;
	/** The chat's title, or the file's path — the cluster label's source. */
	name: string;
	/** A real chat (its record still exists) or an imported notes file. */
	kind: "chat" | "file";
	/** When the session began: the chat's createdAt, or the file's importedAt. */
	createdAt: string | null;
	/** Most recent activity: the chat's updatedAt, or the file's importedAt. */
	updatedAt: string | null;
	/** How many propositions were BORN in this session (birth-session clustering's count — shared/re-encountered nodes count for their birth session only). */
	propositions: number;
}

/** The prober's session list: every birth session, most-recently-active first (undatable records sink, in stable id order). */
export function graphSessionIndex(deps: GraphDeps): GraphSessionEntry[] {
	const counts = new Map<string, number>();
	const born = getGraph(deps.graphStore);
	for (const cluster of birthSessionPartition(born.nodes)) {
		counts.set(cluster.id, cluster.members.length);
	}
	const chats = new Map(deps.chatStore.listChats().map((chat) => [chat.id, chat]));
	const sources = new Map(deps.graphStore.readSources().map((s) => [s.id, s]));
	const entries: GraphSessionEntry[] = [];
	for (const [id, propositions] of counts) {
		const chat = chats.get(id);		if (chat) {
			entries.push({
				id,
				name: chat.title,
				kind: "chat",
				createdAt: chat.createdAt,
				updatedAt: chat.updatedAt,
				propositions,
			});
			continue;
		}
		const source = sources.get(id);
		entries.push({
			id,
			name: source?.filePath ?? id,
			kind: "file",
			createdAt: source?.importedAt ?? null,
			updatedAt: source?.importedAt ?? null,
			propositions,
		});
	}
	return entries.sort(
		(a, b) =>
			(b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
			(b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
			(a.id < b.id ? -1 : 1),
	);
}

/** One birth proposition of one session — WHAT WAS COVERED there. */
interface GraphSessionProposition {
	nodeId: string;
	/** The compact handle — the same name the canvas shows. */
	name: string;
}

/** The propositions BORN in one session — what that session first articulated. */
export function graphSessionPropositions(deps: GraphDeps, sessionId: string): GraphSessionProposition[] {
	const born = getGraph(deps.graphStore).nodes.filter((node) => birthSessionOf(node) === sessionId);
	return born
		.map((node) => ({ nodeId: node.id, name: node.name }))
		.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}


