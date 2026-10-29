/**
 * Coding chats (owner 2026-10-29): a lesson tutor opens a linked coding
 * chat with `coding_open` when the learner asks to move to the coding
 * part. The coding chat is its own session (kind "code") that runs Claude
 * Code inside a per-topic workspace folder under CODE_WORKSPACES, with a
 * shell and the VS Code link (launch.ts). Its first message carries the
 * setup brief; the lesson stays readable through resume_session.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { CODE_WORKSPACES } from "../../../config.ts";
import { newUserMessage } from "../../core/native-messages.ts";
import { stores } from "../stores.ts";
import { attachWorkspace, readTree, subtreeIds } from "./learning-tree.ts";
import type { BridgeResult, ListedTool } from "./tools.ts";

/** A workspace folder name: one path segment, no dots in front. */
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const CODING_TOOLS: ListedTool[] = [
	{
		name: "coding_open",
		description:
			"Open the linked coding chat for this lesson, once the learner has confirmed the folder name. " +
			`Creates (or reuses) the workspace folder ${CODE_WORKSPACES}\\<folder> and a coding session whose tutor sets the workspace up ` +
			"(dependencies, environment) and then helps while the learner codes. Returns the link to give the learner with send_to_user.",
		inputSchema: Type.Object({
			folder: Type.String({ minLength: 1, maxLength: 64, description: "The workspace folder name the learner confirmed, e.g. cs285-hw1." }),
			brief: Type.String({
				minLength: 1,
				description: "What the coding part is: the assignment or exercise, its source (repo URL, course page) if known, and what the environment needs.",
			}),
			node: Type.Optional(Type.String({ description: "The practice node in this session's learning-tree branch that this coding work is for (its id)." })),
		}),
	},
];

/** Create (or find) the coding chat for a lesson + folder. */
export function openCodingChat(lessonChatId: string, folder: string, brief: string, node?: string): { chatId: string; workspace: string; reused: boolean } | { error: string } {
	const lesson = stores.chatStore.getChat(lessonChatId);
	if (!lesson) return { error: "Unknown lesson session." };
	if ((lesson.kind ?? "teach") !== "teach") return { error: "coding_open is for lesson sessions." };
	if (!FOLDER.test(folder)) return { error: `Invalid folder name "${folder}": use letters, digits, dot, dash or underscore (one folder, no path).` };
	if (node !== undefined && !(lesson.branchId && subtreeIds(readTree(), lesson.branchId).has(node))) return { error: `{${node}} is not in this session's learning-tree branch.` };
	const workspace = path.join(CODE_WORKSPACES, folder);

	const existing = stores.chatStore
		.listChats()
		.map((c) => (c.kind === "code" ? stores.chatStore.getChat(c.id) : null))
		.find((c) => c?.workspace === workspace && c.lessonChatId === lessonChatId);
	if (existing) {
		if (node !== undefined) attachWorkspace(node, existing.id, workspace);
		return { chatId: existing.id, workspace, reused: true };
	}

	fs.mkdirSync(workspace, { recursive: true });
	const chat = stores.chatStore.createChat(`Code: ${lesson.title}`, "code", { workspace, lessonChatId, ...(node !== undefined ? { branchId: node } : {}) });
	if (node !== undefined) attachWorkspace(node, chat.id, workspace);
	stores.chatStore.saveMessages(chat.id, [
		newUserMessage(`Coding part of my lesson "${lesson.title}".\n\nWorkspace: ${workspace}\n\n${brief}`),
	]);
	return { chatId: chat.id, workspace, reused: false };
}

export function callCodingTool(chatId: string, name: string, raw: unknown): BridgeResult | null {
	if (name !== "coding_open") return null;
	const args = (raw ?? {}) as { folder?: unknown; brief?: unknown; node?: unknown };
	const folder = String(args.folder ?? "").trim();
	const brief = String(args.brief ?? "").trim();
	if (!folder || !brief) return { text: "coding_open needs a folder and a brief.", isError: true };
	const node = typeof args.node === "string" && args.node.trim() ? args.node.trim() : undefined;
	const opened = openCodingChat(chatId, folder, brief, node);
	if ("error" in opened) return { text: opened.error, isError: true };
	return {
		text:
			`${opened.reused ? "Reopened the existing" : "Opened a new"} coding chat (workspace ${opened.workspace}). ` +
			`Give the learner this link with send_to_user: [Open the coding chat](/chat/${opened.chatId})`,
	};
}
