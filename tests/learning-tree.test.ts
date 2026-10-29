/** The learning tree's pure core (src/server/claude/learning-tree.ts): one node per topic, several parents, cycles refused, outline, removal. */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tree-"));
const { outline, pathTo, removeNode, subtreeIds, upsertNodes } = await import("../src/server/claude/learning-tree.ts");
type Nodes = Parameters<typeof outline>[0];

function build(): Nodes {
	const out = upsertNodes([], [
		{ title: "Academia", kind: "group" },
		{ title: "RL", kind: "group", parents: ["Academia"] },
		{ title: "CS285", kind: "group", parents: ["Academia"] },
		{ title: "MDP", parents: ["RL", "CS285"] },
		{ title: "Bellman equations", parents: ["MDP"] },
	]);
	assert.ok("nodes" in out);
	return out.nodes;
}

describe("learning tree", () => {
	it("ids are title slugs; parents resolve by id or title", () => {
		const nodes = build();
		assert.deepEqual(nodes.map((n) => n.id), ["academia", "rl", "cs285", "mdp", "bellman-equations"]);
		assert.deepEqual(nodes.find((n) => n.id === "mdp")!.parents, ["rl", "cs285"]);
	});
	it("an existing title is the same topic: parents are added, nothing is copied", () => {
		const out = upsertNodes(build(), [{ title: "  mdp ", status: "done", parents: ["academia"] }]);
		assert.ok("nodes" in out);
		assert.deepEqual(out.changed, [{ id: "mdp", created: false }]);
		const mdp = out.nodes.filter((n) => n.title === "MDP");
		assert.equal(mdp.length, 1);
		assert.equal(mdp[0]!.status, "done");
		assert.deepEqual(mdp[0]!.parents, ["rl", "cs285", "academia"]);
	});
	it("refuses cycles, unknown parents and unknown ids — all or nothing", () => {
		const prior = build();
		const out = upsertNodes(prior, [{ title: "New", parents: ["RL"] }, { title: "RL", parents: ["Bellman equations"] }]);
		assert.ok("errors" in out && /cycle/.test(out.errors[0]!));
		assert.ok("errors" in upsertNodes(prior, [{ title: "Y", parents: ["nope"] }]));
		assert.ok("errors" in upsertNodes(prior, [{ id: "nope", title: "Y" }]));
	});
	it("outline writes a shared topic once and points back to it", () => {
		const text = outline(build());
		assert.equal((text.match(/\[ \] MDP \{mdp\}/g) ?? []).length, 1);
		assert.match(text, /↪ MDP \{mdp\}/);
		assert.match(text, /^      - \[ \] Bellman equations/m);
	});
	it("subtree and path follow the DAG", () => {
		const nodes = build();
		assert.deepEqual([...subtreeIds(nodes, "cs285")].sort(), ["bellman-equations", "cs285", "mdp"]);
		assert.equal(pathTo(nodes, "bellman-equations"), "Academia › RL › MDP › Bellman equations");
	});
	it("unlinks from one parent, or deletes and leaves children as roots", () => {
		const unlinked = removeNode(build(), "mdp", "rl");
		assert.ok("nodes" in unlinked);
		assert.deepEqual(unlinked.nodes.find((n) => n.id === "mdp")!.parents, ["cs285"]);
		const deleted = removeNode(build(), "mdp");
		assert.ok("nodes" in deleted);
		assert.ok(!deleted.nodes.some((n) => n.id === "mdp"));
		assert.deepEqual(deleted.nodes.find((n) => n.id === "bellman-equations")!.parents, []);
		assert.match(deleted.text, /Now roots: Bellman equations/);
	});
});

describe("learning tree canvas", async () => {
	const { shownStatuses, visibleTree } = await import("../components/learning-tree.tsx");
	it("collapsing a branch hides what is only reachable through it; a shared topic stays via its other parent", () => {
		const nodes = build();
		const { shown, edges } = visibleTree(nodes, new Set(["rl"]));
		assert.ok(shown.has("mdp"), "still under CS285");
		assert.ok(!edges.some((e) => e.from === "rl"));
		assert.ok(!visibleTree(nodes, new Set(["academia"])).shown.has("mdp"));
	});
	it("a group shows its topics' progress", () => {
		const out = upsertNodes(build(), [{ title: "MDP", status: "done" }]);
		assert.ok("nodes" in out);
		assert.equal(shownStatuses(out.nodes).get("cs285"), "learning");
		const all = upsertNodes(out.nodes, [{ title: "Bellman equations", status: "done" }]);
		assert.ok("nodes" in all);
		assert.equal(shownStatuses(all.nodes).get("academia"), "done");
		assert.equal(shownStatuses(build()).get("rl"), "todo");
	});
});
