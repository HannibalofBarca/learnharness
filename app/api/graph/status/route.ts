/** GET /api/graph/status — the in-flight background extraction runs (vision §1: the pipeline status must be visible on the home graph). */
import { chatStore, extractionStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const runs = extractionStatuses().map((run) => ({
		// Unique row id (the registry job key: source id, or "src#i" for chunk jobs) — one source's rows share chatId, and React keys on it would collide.
		id: run.part ? `${run.chatId}#${run.part.i}` : run.chatId,
		chatId: run.chatId,
		// The run's own label (the file path for notes imports) wins; chat runs fall back to the chat store's title.
		title:
			(run.label ?? chatStore.getChat(run.chatId)?.title ?? run.chatId) +
			(run.part ? ` · ${run.part.i}/${run.part.n}` : ""),
		phase: run.phase,
		startedAt: run.startedAt,
		// Live per-stage usage (the money channel): model + per-step CallUsage, accumulated as steps bill.
		usage: run.usage,
	}));
	return Response.json({ runs });
}
