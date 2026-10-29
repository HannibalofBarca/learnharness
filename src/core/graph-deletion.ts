/** Session deletion — the FIRST destructive operation on the append-only graph ledgers. */

import type {
	GraphChain,
	GraphNode,
} from "./contracts.ts";
import type { GraphStore } from "./ports.ts";

/** The two deletion modes. */
export type ChatDeleteMode = "preserve-graph" | "delete-nodes";

/** What one deletion removed from the ledgers (the DELETE response's stats; the UI can show "3 topics, 2 links removed" from this). */
export interface ChatDeletionStats {
	/** Distinct nodes that died entirely (all their lines). */
	nodesRemoved: number;
	/** Chain assertion LINES removed (empty-provenance or dead member). */
	chainsRemoved: number;
	/** Coverage rows removed. */
	coverageRemoved: number;
	/** Checkpoint lines removed. */
	checkpointsRemoved: number;
}

const EMPTY_STATS: ChatDeletionStats = {
	nodesRemoved: 0,
	chainsRemoved: 0,
	coverageRemoved: 0,
	checkpointsRemoved: 0,
};

/** Remove one chat's traces from the graph ledgers. */
export function deleteChatTraces(graphStore: GraphStore, chatId: string, mode: ChatDeleteMode): ChatDeletionStats {
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		throw new Error(`Unknown deletion mode: ${mode as string}`);
	}

	// The bookkeeping rows die in BOTH modes — coverage and checkpoints are extraction state, not graph content.
	const coverage = graphStore.readCoverage().filter((row) => row.chatId !== chatId);
	const checkpoints = graphStore.readCheckpoints().filter((row) => row.chatId !== chatId);
	const stats: ChatDeletionStats = {
		...EMPTY_STATS,
		coverageRemoved: graphStore.readCoverage().length - coverage.length,
		checkpointsRemoved: graphStore.readCheckpoints().length - checkpoints.length,
	};

	if (mode === "preserve-graph") {
		if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
			graphStore.rewriteLedgers({ coverage, checkpoints });
		}
		return stats;
	}

	// ── delete-nodes: the full purge ──────────────────────────────────────
	const nodeLines = graphStore.readNodes();
	const chainLines = graphStore.readChains();

	// Does the chat touch the graph at all?
	const touched =
		nodeLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId)) ||
		chainLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId));
	if (!touched) {
		if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
			graphStore.rewriteLedgers({ coverage, checkpoints });
		}
		return stats;
	}

	// 1.
	const survives = (points: ReadonlyArray<{ chatId: string }>): boolean =>
		points.some((pt) => pt.chatId !== chatId);
	const live = new Set<string>();
	for (const line of nodeLines) {
		if (survives(line.provenance)) live.add(line.id);
	}

	// 2.
	const outNodes: GraphNode[] = [];
	const seenIds = new Set<string>();
	for (const line of nodeLines) {
		if (!live.has(line.id)) continue; // the whole node dies
		const first = !seenIds.has(line.id);
		seenIds.add(line.id);
		const points = line.provenance.filter((pt) => pt.chatId !== chatId);
		if (points.length === line.provenance.length) {
			outNodes.push(line); // untouched by this chat
			continue;
		}
		if (points.length > 0) {
			outNodes.push({ ...line, provenance: points });
			continue;
		}
		if (first) {
			// The create line of a surviving node the deleted chat minted: name/statement/createdAt are the shared identity other sessions recognized — they stay
			outNodes.push({ ...line, provenance: [], aliases: [] });
		}
		// else: the deleted chat's link line — dies with its phrasings.
	}

	// 3.
	const deadNodes = new Set([...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)));
	const outChains: GraphChain[] = [];
	for (const line of chainLines) {
		if (deadNodes.has(line.conclusion) || line.premises.some((premise) => deadNodes.has(premise))) continue;
		const points = line.provenance.filter((pt) => pt.chatId !== chatId);
		// An assertion dies when THIS deletion empties its provenance — a line that already had no points is foreign/legacy data, not this chat's trace
		if (line.provenance.length > 0 && points.length === 0) continue;
		outChains.push(points.length === line.provenance.length ? line : { ...line, provenance: points });
	}

	stats.nodesRemoved = [...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)).length;
	stats.chainsRemoved = chainLines.length - outChains.length;

	graphStore.rewriteLedgers({
		nodes: outNodes,
		chains: outChains,
		coverage,
		checkpoints,
	});

	// 4.
	const deadChainIds = new Set(
		chainLines
			.filter((line) => !outChains.includes(line))
			.map((line) => line.id),
	);
	const positions = graphStore.readPositions();
	const knownNodeIds = new Set(nodeLines.map((line) => line.id));
	const prunedPositions = Object.fromEntries(
		Object.entries(positions).filter(
			([id]) => (live.has(id) || !knownNodeIds.has(id)) && !deadChainIds.has(id),
		),
	);
	if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
		graphStore.writePositions(prunedPositions);
	}

	return stats;
}

// ─── single-node deletion ───────────

/** FULL DEATH for one node, by id: the user pointing at the node IS the intent — references from other sessions do NOT preserve it. */
export interface NodeDeletionStats {
	/** Chain assertion LINES removed (every chain referencing the node). */
	chainsRemoved: number;
}

function nodeLinesOf(graphStore: GraphStore, nodeId: string): GraphNode[] {
	return graphStore.readNodes().filter((line) => line.id === nodeId);
}


/** Full-death one node (or one argument, by its arg_ id). */
export function deleteNodeTraces(graphStore: GraphStore, nodeId: string): NodeDeletionStats | null {
	const chainLines = graphStore.readChains();

	// The argument branch: an arg_ id names a CHAIN, not a proposition — its lines die, and that is the whole death (the member propositions survive
	if (nodeId.startsWith("arg_")) {
		const outChains = chainLines.filter((line) => line.id !== nodeId);
		if (outChains.length === chainLines.length) return null; // unknown argument
		graphStore.rewriteLedgers({ chains: outChains });
		const positions = graphStore.readPositions();
		if (positions[nodeId] !== undefined) {
			const { [nodeId]: _dead, ...rest } = positions;
			graphStore.writePositions(rest);
		}
		return { chainsRemoved: chainLines.length - outChains.length };
	}

	const nodeLines = nodeLinesOf(graphStore, nodeId);
	if (nodeLines.length === 0) return null;

	const outChains = chainLines.filter(
		(line) => line.conclusion !== nodeId && !line.premises.includes(nodeId),
	);

	// Only the touched ledgers: the node's own lines always die (its file must move), everything else rewrites only when rows actually drop.
	const outNodes = graphStore.readNodes().filter((line) => line.id !== nodeId);
	graphStore.rewriteLedgers({
		nodes: outNodes,
		...(outChains.length !== chainLines.length ? { chains: outChains } : {}),
	});

	// The resting positions die with the node and every dead chain.
	const deadChainIds = new Set(chainLines.filter((line) => !outChains.includes(line)).map((line) => line.id));
	const positions = graphStore.readPositions();
	const prunedPositions = Object.fromEntries(
		Object.entries(positions).filter(([id]) => id !== nodeId && !deadChainIds.has(id)),
	);
	if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
		graphStore.writePositions(prunedPositions);
	}

	return {
		chainsRemoved: chainLines.length - outChains.length,
	};
}
