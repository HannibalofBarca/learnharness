/** The learning tree: one map of everything the learner studies — Academia → focus areas → documents → branches → topics. */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { PATHS } from "../../../config.ts";
import { newUserMessage } from "../../core/native-messages.ts";
import type { AgentTool } from "../../core/agent-types.ts";
import type { ChatRecord } from "../../core/contracts/chat.ts";
import { validateArguments } from "../../agent/validate.ts";
import { stores } from "../stores.ts";
import type { BridgeResult, ListedTool } from "./tools.ts";

type TreeKind = "group" | "concept" | "practice";
type TreeStatus = "todo" | "learning" | "done";

interface TreeNode {
	id: string;
	title: string;
	/** group = a purview or branch; concept = taught; practice = coded or drilled. */
	kind: TreeKind;
	status: TreeStatus;
	/** Parent ids; empty = a root. Several = one topic under several purviews. */
	parents: string[];
	/** Where it comes from (document + section). */
	source?: string;
	note?: string;
	/** Sessions (lessons and coding chats) opened on this node. */
	sessions: string[];
	/** A practice node's coding workspace. */
	workspace?: string;
}

const TREE_FILE = () => path.join(PATHS.data, "tree", "nodes.json");

export function readTree(): TreeNode[] {
	try {
		return (JSON.parse(fs.readFileSync(TREE_FILE(), "utf-8")) as { nodes: TreeNode[] }).nodes;
	} catch {
		return [];
	}
}

function writeTree(nodes: TreeNode[]): void {
	const file = TREE_FILE();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, JSON.stringify({ nodes }, null, "\t"), "utf-8");
	fs.renameSync(`${file}.tmp`, file);
}

// ─── pure helpers ───────────────────────────────────────────────────────────

/** The identity of a title: case, spacing and punctuation don't count. */
const titleKey = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function newId(nodes: readonly TreeNode[], title: string): string {
	const base = titleKey(title).replace(/ /g, "-").slice(0, 48).replace(/-+$/, "") || "node";
	const taken = new Set(nodes.map((n) => n.id));
	let id = base;
	for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
	return id;
}

/** A node by id, else by title. */
function resolveNode(nodes: readonly TreeNode[], ref: string): TreeNode | undefined {
	return nodes.find((n) => n.id === ref) ?? nodes.find((n) => titleKey(n.title) === titleKey(ref));
}

function childrenOf(nodes: readonly TreeNode[], id: string): TreeNode[] {
	return nodes.filter((n) => n.parents.includes(id));
}

/** The node and everything under it. */
export function subtreeIds(nodes: readonly TreeNode[], rootId: string): Set<string> {
	const out = new Set<string>([rootId]);
	const queue = [rootId];
	while (queue.length > 0) {
		const id = queue.shift()!;
		for (const child of childrenOf(nodes, id)) {
			if (!out.has(child.id)) {
				out.add(child.id);
				queue.push(child.id);
			}
		}
	}
	return out;
}

/** "Academia › Robot Learning › RL" — along first parents. */
export function pathTo(nodes: readonly TreeNode[], id: string): string {
	const parts: string[] = [];
	const seen = new Set<string>();
	for (let node = nodes.find((n) => n.id === id); node && !seen.has(node.id); node = nodes.find((n) => n.id === node!.parents[0])) {
		seen.add(node.id);
		parts.unshift(node.title);
	}
	return parts.join(" › ");
}

const GLYPH: Record<TreeStatus, string> = { todo: "[ ]", learning: "[~]", done: "[x]" };

/** The tree as a compact outline (the agents' view). */
export function outline(nodes: readonly TreeNode[], roots?: readonly string[]): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	const visit = (node: TreeNode, depth: number) => {
		const indent = "  ".repeat(depth);
		if (seen.has(node.id)) {
			lines.push(`${indent}- ↪ ${node.title} {${node.id}} (shared, see above)`);
			return;
		}
		seen.add(node.id);
		const extras = [
			node.kind === "concept" ? "" : node.kind,
			node.parents.length > 1 ? `${node.parents.length} parents` : "",
			node.source ? `src: ${node.source}` : "",
			node.sessions.length ? `sessions: ${node.sessions.join(",")}` : "",
			node.workspace ? `ws: ${node.workspace}` : "",
			node.note ?? "",
		].filter(Boolean);
		lines.push(`${indent}- ${GLYPH[node.status]} ${node.title} {${node.id}}${extras.length ? ` · ${extras.join(" · ")}` : ""}`);
		for (const child of childrenOf(nodes, node.id)) visit(child, depth + 1);
	};
	const starts = roots ? roots.flatMap((id) => nodes.filter((n) => n.id === id)) : nodes.filter((n) => n.parents.length === 0);
	for (const root of starts) visit(root, 0);
	return lines.length ? lines.join("\n") : "(empty tree)";
}

interface UpsertInput {
	id?: string;
	title: string;
	kind?: TreeKind;
	status?: TreeStatus;
	/** Parent ids or titles — ADDED to the node's parents (never removes). */
	parents?: string[];
	source?: string;
	note?: string;
}

/** Create or update nodes (in order — a parent may be created earlier in the same batch). */
export function upsertNodes(prior: readonly TreeNode[], inputs: readonly UpsertInput[]): { nodes: TreeNode[]; changed: { id: string; created: boolean }[] } | { errors: string[] } {
	const nodes = prior.map((n) => ({ ...n, parents: [...n.parents], sessions: [...n.sessions] }));
	const errors: string[] = [];
	const changed: { id: string; created: boolean }[] = [];
	for (const input of inputs) {
		const title = input.title.trim();
		if (!title) {
			errors.push("A node needs a title.");
			continue;
		}
		let node = input.id ? nodes.find((n) => n.id === input.id) : resolveNode(nodes, title);
		if (input.id && !node) {
			errors.push(`No node {${input.id}} — omit id to create "${title}".`);
			continue;
		}
		const created = !node;
		if (!node) {
			node = { id: newId(nodes, title), title, kind: input.kind ?? "concept", status: input.status ?? "todo", parents: [], sessions: [] };
			nodes.push(node);
		} else {
			if (input.id) node.title = title;
			if (input.kind) node.kind = input.kind;
			if (input.status) node.status = input.status;
		}
		if (input.source !== undefined) node.source = input.source;
		if (input.note !== undefined) node.note = input.note;
		for (const ref of input.parents ?? []) {
			const parent = resolveNode(nodes, ref);
			if (!parent) errors.push(`"${title}": no parent "${ref}".`);
			else if (subtreeIds(nodes, node.id).has(parent.id)) errors.push(`"${title}" under "${parent.title}" would make a cycle.`);
			else if (!node.parents.includes(parent.id)) node.parents.push(parent.id);
		}
		changed.push({ id: node.id, created });
	}
	return errors.length ? { errors } : { nodes, changed };
}

/** Unlink a node from one parent, or delete it (its children stay; any left without a parent become roots). */
export function removeNode(prior: readonly TreeNode[], id: string, parent?: string): { nodes: TreeNode[]; text: string } | { error: string } {
	const node = prior.find((n) => n.id === id);
	if (!node) return { error: `No node {${id}}.` };
	if (parent !== undefined) {
		if (!node.parents.includes(parent)) return { error: `{${id}} is not under {${parent}}.` };
		const nodes = prior.map((n) => (n.id === id ? { ...n, parents: n.parents.filter((p) => p !== parent) } : n));
		return { nodes, text: `Unlinked "${node.title}" from {${parent}}${node.parents.length === 1 ? "; it is now a root" : ""}.` };
	}
	const orphans = prior.filter((n) => n.parents.length === 1 && n.parents[0] === id).map((n) => n.title);
	const nodes = prior.filter((n) => n.id !== id).map((n) => (n.parents.includes(id) ? { ...n, parents: n.parents.filter((p) => p !== id) } : n));
	return { nodes, text: `Deleted "${node.title}".${orphans.length ? ` Now roots: ${orphans.join(", ")}.` : ""}` };
}

// ─── sessions on the tree ───────────────────────────────────────────────────

/** Open a new teaching session on a node: its first message carries the node's place in the tree and its branch as it stands. */
export function openBranchSession(id: string): { chatId: string } | { error: string } {
	const nodes = readTree();
	const node = nodes.find((n) => n.id === id);
	if (!node) return { error: `No node {${id}}.` };
	const chat = stores.chatStore.createChat(node.title, undefined, { branchId: node.id });
	stores.chatStore.saveMessages(chat.id, [
		newUserMessage(
			[
				node.title,
				"",
				`This session is on my learning tree: ${pathTo(nodes, node.id)}.${node.source ? ` Source: ${node.source}.` : ""}${node.note ? ` ${node.note}` : ""}`,
				"The branch as it stands (tree_branch shows it live):",
				"",
				outline(nodes, [node.id]),
			].join("\n"),
		),
	]);
	node.sessions.push(chat.id);
	writeTree(nodes);
	return { chatId: chat.id };
}

/** Record a coding chat (and its workspace) on a practice node. */
export function attachWorkspace(id: string, chatId: string, workspace: string): boolean {
	const nodes = readTree();
	const node = nodes.find((n) => n.id === id);
	if (!node) return false;
	node.workspace = workspace;
	if (!node.sessions.includes(chatId)) node.sessions.push(chatId);
	writeTree(nodes);
	return true;
}

/** The tree for the Planner page: sessions that no longer exist dropped, plus the live ones' titles and kinds. */
export function treeView(): { nodes: TreeNode[]; sessions: Record<string, { title: string; kind: string }> } {
	const chats = new Map(stores.chatStore.listChats().map((c) => [c.id, c] as const));
	const nodes = readTree().map((n) => ({ ...n, sessions: n.sessions.filter((s) => chats.has(s)) }));
	const sessions: Record<string, { title: string; kind: string }> = {};
	for (const n of nodes) for (const s of n.sessions) sessions[s] = { title: chats.get(s)!.title, kind: chats.get(s)!.kind ?? "teach" };
	return { nodes, sessions };
}

// ─── tools ──────────────────────────────────────────────────────────────────

const KIND = Type.Union([Type.Literal("group"), Type.Literal("concept"), Type.Literal("practice")], { description: "group = purview/branch; concept = taught; practice = coded or drilled." });
const STATUS = Type.Union([Type.Literal("todo"), Type.Literal("learning"), Type.Literal("done")]);

const SCHEMAS = {
	tree_get: Type.Object({ root: Type.Optional(Type.String({ description: "A node id to show only its branch; omit for the whole tree." })) }),
	tree_upsert: Type.Object({
		nodes: Type.Array(
			Type.Object({
				id: Type.Optional(Type.String({ description: "Update this node (e.g. rename). Omit to create — or to update the node with this title if it exists." })),
				title: Type.String({ minLength: 1 }),
				kind: Type.Optional(KIND),
				status: Type.Optional(STATUS),
				parents: Type.Optional(Type.Array(Type.String(), { description: "Parent ids or titles, added to the node's parents (earlier items of this batch count)." })),
				source: Type.Optional(Type.String({ description: "Document + section it comes from." })),
				note: Type.Optional(Type.String()),
			}),
			{ minItems: 1 },
		),
	}),
	tree_remove: Type.Object({
		id: Type.String(),
		parent: Type.Optional(Type.String({ description: "Only unlink the node from this parent id; omit to delete the node." })),
	}),
	tree_open_session: Type.Object({ id: Type.String({ description: "The node (usually a branch) to teach." }) }),
	tree_branch: Type.Object({ id: Type.Optional(Type.String({ description: "A node inside your branch; omit for your whole branch." })) }),
	tree_add: Type.Object({
		title: Type.String({ minLength: 1 }),
		parent: Type.String({ description: "Id of the node in your branch to add it under." }),
		kind: Type.Optional(KIND),
		note: Type.Optional(Type.String()),
	}),
	tree_status: Type.Object({ id: Type.String(), status: STATUS }),
};

const tool = (name: keyof typeof SCHEMAS, description: string): ListedTool => ({ name, description, inputSchema: SCHEMAS[name] });

export const TREE_PLANNER_TOOLS: ListedTool[] = [
	tool("tree_get", "Read the learning tree as an outline: [ ] todo, [~] learning, [x] done; {id}; ↪ marks a shared topic shown above."),
	tool("tree_upsert", "Create or update learning-tree nodes. A title that already exists is the same topic: its node gains the new parents (one topic, several purviews) instead of a copy."),
	tool("tree_remove", "Unlink a node from one parent, or delete it (children stay)."),
	tool("tree_open_session", "Open a new teaching session on a tree node; its tutor works through that branch. Returns the session id."),
];

export const TREE_TUTOR_TOOLS: ListedTool[] = [
	tool("tree_branch", "This session's branch of the learner's learning tree, as an outline ([ ] todo, [~] learning, [x] done; {id})."),
	tool("tree_add", "Add a sub-branch or leaf topic under a node in your branch. If the topic already exists anywhere in the tree, it is linked here instead of copied — progress is shared."),
	tool("tree_status", "Mark a node in your branch: learning (started) or done (the learner understands it), or back to todo."),
];

function parse(name: keyof typeof SCHEMAS, raw: unknown): { args: Record<string, unknown> } | BridgeResult {
	const checked = validateArguments({ name, parameters: SCHEMAS[name] } as AgentTool<any>, raw);
	return checked.ok ? { args: checked.args as Record<string, unknown> } : { text: checked.error, isError: true };
}

function upsertResult(inputs: UpsertInput[]): BridgeResult {
	const out = upsertNodes(readTree(), inputs);
	if ("errors" in out) return { text: `Nothing saved:\n${out.errors.join("\n")}`, isError: true };
	writeTree(out.nodes);
	return { text: out.changed.map((c) => `${c.created ? "created" : "updated"} {${c.id}}`).join("\n") };
}

export function callTreePlannerTool(name: string, raw: unknown): BridgeResult | null {
	if (!(name in SCHEMAS) || !TREE_PLANNER_TOOLS.some((t) => t.name === name)) return null;
	const parsed = parse(name as keyof typeof SCHEMAS, raw);
	if (!("args" in parsed)) return parsed;
	const args = parsed.args;
	if (name === "tree_get") {
		const nodes = readTree();
		if (args.root !== undefined && !nodes.some((n) => n.id === args.root)) return { text: `No node {${String(args.root)}}.`, isError: true };
		return { text: outline(nodes, args.root === undefined ? undefined : [String(args.root)]) };
	}
	if (name === "tree_upsert") return upsertResult(args.nodes as UpsertInput[]);
	if (name === "tree_remove") {
		const out = removeNode(readTree(), String(args.id), args.parent === undefined ? undefined : String(args.parent));
		if ("error" in out) return { text: out.error, isError: true };
		writeTree(out.nodes);
		return { text: out.text };
	}
	const opened = openBranchSession(String(args.id));
	return "error" in opened ? { text: opened.error, isError: true } : { text: `Session ${opened.chatId} is open in the sidebar; the learner starts it by opening it.` };
}

export function callTreeTutorTool(record: ChatRecord, name: string, raw: unknown): BridgeResult | null {
	if (!TREE_TUTOR_TOOLS.some((t) => t.name === name)) return null;
	const branch = record.branchId;
	const nodes = readTree();
	if (!branch || !nodes.some((n) => n.id === branch)) return { text: "This session is not on a learning-tree branch.", isError: true };
	const parsed = parse(name as keyof typeof SCHEMAS, raw);
	if (!("args" in parsed)) return parsed;
	const args = parsed.args;
	const mine = subtreeIds(nodes, branch);
	const inBranch = (id: string): BridgeResult | null => (mine.has(id) ? null : { text: `{${id}} is not in this session's branch {${branch}}.`, isError: true });
	if (name === "tree_branch") {
		const id = args.id === undefined ? branch : String(args.id);
		return inBranch(id) ?? { text: outline(nodes, [id]) };
	}
	if (name === "tree_add") {
		const parent = String(args.parent);
		return inBranch(parent) ?? upsertResult([{ title: String(args.title), parents: [parent], ...(args.kind ? { kind: args.kind as TreeKind } : {}), ...(args.note ? { note: String(args.note) } : {}) }]);
	}
	const id = String(args.id);
	return inBranch(id) ?? upsertResult([{ id, title: nodes.find((n) => n.id === id)!.title, status: args.status as TreeStatus }]);
}
