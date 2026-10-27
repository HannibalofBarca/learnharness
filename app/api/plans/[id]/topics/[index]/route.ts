/** POST /api/plans/:id/topics/:index — open (or reopen) the topic's session. */
import { openTopicSession } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; index: string }> }) {
	const { id, index } = await ctx.params;
	const out = openTopicSession(id, Number(index));
	return "error" in out ? Response.json(out, { status: 404 }) : Response.json(out);
}
