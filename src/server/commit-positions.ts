/** Server-side commit for the live physics drag (PUT /api/graph/positions). */
import type { Position } from "../core/contracts.ts";
import { deriveView, getGraph } from "../core/graph.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import { stores } from "./stores.ts";

/** Max |x| or |y| accepted — NaN/Infinity clamp here, absurd too. */
const MAX_COORD = 1e6;

/** Accepts the raw PUT body (a Record of id → {x, y}) and returns the sanitized positions actually persisted (empty object = nothing written */
export function commitPositions(input: unknown): Record<string, Position> {
	if (typeof input !== "object" || input === null) return {};
	const raw = input as Record<string, unknown>;

	// Only ids the canvas's world actually has: stored propositions plus the DERIVED arg_ implication nodes (deriveView of the current graph
	const known = new Set(deriveView(getGraph(stores.graphStore)).nodes.map((n) => n.id));

	const positions: Record<string, Position> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (!known.has(id)) continue;
		if (typeof value !== "object" || value === null) continue;
		const { x, y } = value as Record<string, unknown>;
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
			continue;
		positions[id] = {
			x: Math.min(Math.max(x, -MAX_COORD), MAX_COORD),
			y: Math.min(Math.max(y, -MAX_COORD), MAX_COORD),
		};
	}
	if (Object.keys(positions).length === 0) return {};

	stores.graphStore.writePositions(positions);

	// The graph grew past what the client knew (a merge landed mid-drag): absorb the new nodes with the client's rest state as anchors.
	for (const id of known) {
		if (!(id in positions)) {
			settleGraphLayout(stores.graphStore);
			break;
		}
	}
	return positions;
}