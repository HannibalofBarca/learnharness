import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	blockLayout,
	topoFor,
	wrapTitle,
	GAP_X,
	NODE_H,
	NODE_W_MIN,
	nodeWidth,
} from "../components/plan-block.tsx";
import type { PlanTree } from "../src/core/contracts.ts";

// Plan blocks: the pure layered layout, the frozen-snapshot rendering (full = borderless + column-filling with the glowing current)

const CHAIN: PlanTree = {
	nodes: [
		{ id: "a", title: "Alpha node" },
		{ id: "b", title: "Beta node" },
		{ id: "c", title: "Gamma node" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	version: 1,
};

describe("plan block layout (pure)", () => {
	it("layers a chain top-down, one node per depth row", () => {
		const { order, depth } = topoFor(CHAIN.nodes, CHAIN.edges);
		assert.deepEqual(order.map((n) => n.id), ["a", "b", "c"]);
		assert.equal(depth.get("c"), 2);
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		// Text-first sizing: these short titles hug to the minimum — no more fixed 160px slabs.
		const W = nodeWidth(wrapTitle("Alpha node"));
		assert.equal(W, NODE_W_MIN); // est ≈ 50 → floored at the min
		// All three short titles floor — the extent is the floor itself.
		assert.equal(nodeWidth(wrapTitle("Gamma node")), NODE_W_MIN); // est ≈ 59.9
		assert.equal(layout.width, NODE_W_MIN);
		assert.equal(layout.height, 3 * NODE_H + 2 * 48);
		assert.equal(layout.nodeW.get("a"), W);
	});

	it("centers same-depth nodes over the widest row; tolerates dangling edges", () => {
		const nodes = [
			{ id: "r", title: "Root" },
			{ id: "x", title: "Left" },
			{ id: "y", title: "Right" },
		];
		const layout = blockLayout(nodes, [
			{ from: "r", to: "x" },
			{ from: "r", to: "y" },
			{ from: "ghost", to: "r" }, // dangling: ignored defensively
		]);
		const W = nodeWidth(wrapTitle("Root"));
		assert.equal(layout.width, 2 * W + GAP_X);
		// Root centered over its two children: (2*W+GAP - W)/2
		assert.equal(layout.x.get("r"), (2 * W + GAP_X - W) / 2);
		assert.ok(layout.x.get("x") === 0 && layout.x.get("y") === W + GAP_X);
	});
});