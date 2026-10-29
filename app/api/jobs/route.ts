import { isTurnRunning, listJobs } from "@/src/server";

export const dynamic = "force-dynamic";

/** Job status endpoint (contracts.ts "THE ASYNC PROTOCOL" §4): the chat view's jobs fetch lands here — once on mount */
export async function GET(req: Request) {
	const chatId = new URL(req.url).searchParams.get("chatId");
	if (!chatId) {
		return Response.json({ error: "chatId query parameter is required" }, { status: 400 });
	}
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) {
		return Response.json({ error: "Invalid chatId" }, { status: 400 });
	}
	return Response.json({ jobs: listJobs(chatId), turnInFlight: isTurnRunning(chatId) });
}
