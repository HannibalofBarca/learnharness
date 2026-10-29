/** THE REATTACH STREAM — and, since CONNECTION DIET B, THE turn wire, period: POST /api/chat acknowledges and closes, so the submitter too attaches here. */
import { getChat, runningTurn, piTurnResponse, settledTurnResponse } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const handle = runningTurn(id);
	if (!handle) return settledTurnResponse(id);
	return piTurnResponse(handle);
}
