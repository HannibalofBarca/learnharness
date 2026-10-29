import { chainsForSelection, formatChainLine } from "@/src/core";
import { newGraphContextMessage, type GraphContextPick } from "@/src/core";
import { createChat, isTurnRunning, listChats, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending question) + live liveness */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: false,
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions: kind "practice" marks the record — the practice method + its tools from turn 1, no extraction.
	const kind = body.kind === "practice" ? ("practice" as const) : undefined;
	const chat = createChat(titleFromPrompt(title || "Untitled session"), kind);
	// The session's map context: the picked propositions ride the CREATION
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(picks, chainLines)]);
	}
	return Response.json({ id: chat.id, title: chat.title });
}
